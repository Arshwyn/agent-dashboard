'use strict';

const crypto = require('node:crypto');

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const CLOCK_LEEWAY_S = 30;

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Verifies the Cloudflare Access JWT (header Cf-Access-Jwt-Assertion) for a single owner.
 * Signature RS256 against the team's published keys, issuer, audience, expiry, not-before and email.
 * Fails closed: every problem is a rejection; a key fetch problem is "unavailable", never "allowed".
 * `fetchJson(url)` is injectable for tests; the default uses the global fetch.
 */
class AccessVerifier {
  constructor({ teamDomain, aud, ownerEmail, fetchJson, now = () => Date.now() }) {
    this.issuer = `https://${teamDomain}`;
    this.certsUrl = `${this.issuer}/cdn-cgi/access/certs`;
    this.aud = aud;
    this.owner = ownerEmail;
    this.now = now;
    this.fetchJson =
      fetchJson ||
      (async (url) => {
        const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error('jwks http');
        return r.json();
      });
    this.keys = new Map(); // kid -> KeyObject
    this.fetchedAt = 0;
    this.lastAttempt = 0;
    this.lastError = null; // the last fetch failure, so the throttle window reports unavailable, not unauthorized
    this.inflight = null; // one key fetch at a time; concurrent callers share it
  }

  _refresh() {
    if (this.inflight) return this.inflight;
    const t = this.now();
    if (t - this.lastAttempt < JWKS_MIN_REFETCH_MS) {
      return this.lastError ? Promise.reject(this.lastError) : Promise.resolve();
    }
    this.lastAttempt = t;
    this.inflight = this._fetchKeys(t)
      .then(() => {
        this.lastError = null;
      })
      .catch((e) => {
        this.lastError = e;
        throw e;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async _fetchKeys(t) {
    const doc = await this.fetchJson(this.certsUrl);
    const next = new Map();
    for (const jwk of Array.isArray(doc && doc.keys) ? doc.keys : []) {
      if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // skip a malformed key
      }
    }
    if (next.size === 0) throw new Error('jwks empty');
    this.keys = next;
    this.fetchedAt = t;
  }

  async _key(kid) {
    if (this.keys.has(kid) && this.now() - this.fetchedAt < JWKS_TTL_MS) return this.keys.get(kid);
    try {
      await this._refresh();
    } catch (e) {
      if (!this.keys.has(kid)) throw e;
    }
    return this.keys.get(kid) || null;
  }

  /** Resolves to { ok: true, email } or { ok: false, status, reason }. */
  async verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
      return { ok: false, status: 401, reason: 'missing token' };
    }
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, status: 401, reason: 'malformed token' };
    let header;
    let payload;
    try {
      header = b64urlJson(parts[0]);
      payload = b64urlJson(parts[1]);
    } catch {
      return { ok: false, status: 401, reason: 'malformed token' };
    }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
      return { ok: false, status: 401, reason: 'unsupported token' };
    }
    let key;
    try {
      key = await this._key(header.kid);
    } catch {
      return { ok: false, status: 503, reason: 'keys unavailable' };
    }
    if (!key) return { ok: false, status: 401, reason: 'unknown key' };
    const okSig = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!okSig) return { ok: false, status: 401, reason: 'bad signature' };

    const nowS = Math.floor(this.now() / 1000);
    if (!payload || typeof payload !== 'object') return { ok: false, status: 401, reason: 'bad claims' };
    if (payload.iss !== this.issuer) return { ok: false, status: 401, reason: 'bad issuer' };
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.aud)) return { ok: false, status: 401, reason: 'bad audience' };
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_LEEWAY_S < nowS) {
      return { ok: false, status: 401, reason: 'expired' };
    }
    if (
      payload.nbf !== undefined &&
      (typeof payload.nbf !== 'number' || payload.nbf - CLOCK_LEEWAY_S > nowS)
    ) {
      return { ok: false, status: 401, reason: 'not yet valid' };
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (email !== this.owner) return { ok: false, status: 403, reason: 'not the owner' };
    return { ok: true, email };
  }
}

module.exports = { AccessVerifier };
