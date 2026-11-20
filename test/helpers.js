'use strict';

const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

const TEAM = 'team.example.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OWNER = 'owner@example.com';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64(o) {
  return Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
}

/** Builds a signed Access-style token. Overrides patch the claims; `key`/`kid`/`alg` patch the signing. */
function makeToken(claims = {}, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: OWNER,
    iat: now,
    nbf: now - 5,
    exp: now + 600,
    ...claims,
  };
  const head = `${b64({ alg, kid, typ: 'JWT' })}.${b64(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url');
  return `${head}.${sig}`;
}

function baseEnv(extra = {}) {
  return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER, ...extra };
}

async function startApp(envExtra = {}, opts = {}) {
  const config = loadConfig(baseEnv(envExtra));
  const fetchJson = opts.fetchJson || (async () => ({ keys: [jwk] }));
  const app = createApp(config, { ...opts, fetchJson });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, config, stop: () => app.close() };
}

async function get(base, path, headers = {}) {
  const r = await fetch(base + path, { headers, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, headers: r.headers, text, json };
}

const CSRF = { 'X-Hub-Request': '1', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };

module.exports = {
  CSRF,
  TEAM,
  AUD,
  OWNER,
  jwk,
  other,
  makeToken,
  baseEnv,
  startApp,
  get,
};
