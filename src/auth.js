'use strict';

const crypto = require('node:crypto');

/** Constant-time string comparison that does not leak length (compares SHA-256 digests). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Sliding-window failure limiter keyed by string (e.g. client IP). */
class FailureLimiter {
  constructor({ max = 5, windowMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  _recent(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Returns seconds to wait if blocked, else 0. */
  blockedFor(key) {
    const list = this._recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key) {
    const list = this._recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10000) this.hits.delete(this.hits.keys().next().value);
  }

  reset(key) {
    this.hits.delete(key);
  }
}

/** In-memory sessions: only the SHA-256 of the cookie value is retained. */
class SessionStore {
  constructor({ ttlMs, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  _h(id) {
    return crypto.createHash('sha256').update(id).digest('hex');
  }

  /** Stable opaque key for a session id (never the id itself). */
  hash(id) {
    return typeof id === 'string' && id ? this._h(id) : null;
  }

  /** Is the session identified by hash() still live? Expires it if not. */
  validHash(h) {
    const exp = this.sessions.get(h);
    if (!exp) return false;
    if (exp < this.now()) {
      this.sessions.delete(h);
      return false;
    }
    return true;
  }

  create() {
    const id = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(this._h(id), this.now() + this.ttlMs);
    if (this.sessions.size > 1000) this.sweep();
    return id;
  }

  valid(id) {
    if (typeof id !== 'string' || !id) return false;
    const h = this._h(id);
    const exp = this.sessions.get(h);
    if (!exp) return false;
    if (exp < this.now()) {
      this.sessions.delete(h);
      return false;
    }
    return true;
  }

  destroy(id) {
    if (typeof id === 'string') this.sessions.delete(this._h(id));
  }

  sweep() {
    const t = this.now();
    for (const [k, exp] of this.sessions) if (exp < t) this.sessions.delete(k);
  }
}

module.exports = { safeEqual, bearer, parseCookies, FailureLimiter, SessionStore };
