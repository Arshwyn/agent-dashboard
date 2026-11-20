'use strict';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const TEAM_DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const AUD = /^[A-Za-z0-9]{16,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read and validate the configuration from an environment object. Throws an Error with a plain
 * message (never a value) when something required is missing or invalid, so the process fails closed.
 *
 *   ACCESS_TEAM_DOMAIN  hostname of the Cloudflare Access team (no scheme, no path)
 *   ACCESS_AUD          the Access application audience tag
 *   OWNER_EMAIL         the single allowed identity
 *   DEV_AUTH_BYPASS     "1" turns Access off for local development; refused in production or off loopback
 *   APOLLO_CHAT_URL     optional https link-out for the Apollo card; empty hides it
 */
function loadConfig(env) {
  const host = (env.HOST || '127.0.0.1').trim();
  const port = Number.parseInt(env.PORT || '8787', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be 0-65535');

  const production = env.NODE_ENV === 'production';
  const bypass = env.DEV_AUTH_BYPASS === '1';
  if (env.DEV_AUTH_BYPASS && env.DEV_AUTH_BYPASS !== '1' && env.DEV_AUTH_BYPASS !== '0') {
    throw new Error('DEV_AUTH_BYPASS must be 1 or 0');
  }
  if (bypass) {
    if (production) throw new Error('DEV_AUTH_BYPASS is not allowed when NODE_ENV=production');
    if (!LOOPBACK.has(host)) throw new Error('DEV_AUTH_BYPASS is only allowed with HOST on loopback');
  }

  let team = '';
  let aud = '';
  let owner = '';
  if (!bypass) {
    team = String(env.ACCESS_TEAM_DOMAIN || '')
      .trim()
      .toLowerCase();
    if (!TEAM_DOMAIN.test(team))
      throw new Error('ACCESS_TEAM_DOMAIN must be a hostname such as <team>.example.com');
    aud = String(env.ACCESS_AUD || '').trim();
    if (!AUD.test(aud)) throw new Error('ACCESS_AUD must be the Access application audience tag');
    owner = String(env.OWNER_EMAIL || '')
      .trim()
      .toLowerCase();
    if (!EMAIL.test(owner)) throw new Error('OWNER_EMAIL must be an email address');
  }

  let apolloChatUrl = '';
  if (env.APOLLO_CHAT_URL) {
    let u;
    try {
      u = new URL(env.APOLLO_CHAT_URL);
    } catch {
      throw new Error('APOLLO_CHAT_URL must be an absolute https URL');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
      throw new Error('APOLLO_CHAT_URL must be an absolute https URL');
    }
    apolloChatUrl = u.href;
  }

  return {
    host,
    port,
    production,
    devBypass: bypass,
    accessTeamDomain: team,
    accessAud: aud,
    ownerEmail: owner,
    apolloChatUrl,
    maxBodyBytes: 65536,
  };
}

function startupWarnings(config) {
  return config.devBypass
    ? ['DEV_AUTH_BYPASS is on: Access verification is OFF (local development only)']
    : [];
}

module.exports = { loadConfig, startupWarnings };
