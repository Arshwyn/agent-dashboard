'use strict';

const { loadPricing } = require('./pricing');
const { UNTRACKED_AGENTS } = require('./state');

const DEFAULT_AGENTS = ['orchestrator'];
// Display names for parallel instances of one role (generic given names, not identities).
const DEFAULT_AGENT_NAMES = ['Ada', 'Bram', 'Carl', 'Dax', 'Ena', 'Finn', 'Gia', 'Hugo'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const MAX_NAMES = 99;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

const MIN_TOKEN_LENGTH = 20;
const WEAK_FRAGMENTS = [
  'changeme',
  'change-me',
  'change_me',
  'replace',
  'placeholder',
  'example',
  'password',
  'default',
  'secret',
  'your_',
  'your-',
  'token',
  'xxxx',
];

function validateToken(name, value) {
  if (!value) return `${name} is not set`;
  if (value.length < MIN_TOKEN_LENGTH) return `${name} must be at least ${MIN_TOKEN_LENGTH} characters`;
  const lower = value.toLowerCase();
  if (WEAK_FRAGMENTS.some((f) => lower.includes(f))) {
    return `${name} looks like a placeholder or default value; generate a random one`;
  }
  if (new Set(value).size < 8) return `${name} has too little variety; generate a random one`;
  return null;
}

function int(env, key, def, { min = 0 } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be an integer >= ${min}`);
  return n;
}

function parseNames(raw, reserved = []) {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_AGENT_NAMES];
  const names = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!names.length || names.length > MAX_NAMES) {
    throw new Error(`AGENT_NAMES must list 1-${MAX_NAMES} comma-separated names`);
  }
  const bad = names.find((x) => !NAME_RE.test(x));
  if (bad !== undefined) throw new Error(`AGENT_NAMES entry "${bad}" must match ${NAME_RE}`);
  if (new Set(names.map((x) => x.toLowerCase())).size !== names.length) {
    throw new Error('AGENT_NAMES must not repeat a name');
  }
  // `extra-<n>` is reserved for the overflow people, so a pool name must not look like one.
  const overflow = names.find((x) => /^extra-\d+$/i.test(x));
  if (overflow !== undefined) {
    throw new Error(`AGENT_NAMES entry "${overflow}" must not look like an overflow id (extra-<n>)`);
  }
  // A person must never shadow a role card (a configured AGENTS entry or an untracked name).
  const taken = new Set([...reserved, ...UNTRACKED_AGENTS].map((x) => x.toLowerCase()));
  const clash = names.find((x) => taken.has(x.toLowerCase()));
  if (clash !== undefined) throw new Error(`AGENT_NAMES entry "${clash}" clashes with an agent or role name`);
  return names;
}

/**
 * Parse AGENT_DISPLAY_NAMES (`id=Label,id2=Label 2`) into { id: label }. Display only: keys must be
 * role cards. Errors name the key or the entry position, never the label.
 */
function parseDisplayNames(raw, roles) {
  if (raw === undefined || raw.trim() === '') return {};
  const out = {};
  raw.split(',').forEach((entry, i) => {
    const eq = entry.indexOf('=');
    if (eq < 0) throw new Error(`AGENT_DISPLAY_NAMES entry ${i + 1} must be id=Label`);
    const key = entry.slice(0, eq).trim();
    const label = entry.slice(eq + 1).trim();
    if (!roles.includes(key)) {
      throw new Error(`AGENT_DISPLAY_NAMES key "${key}" must be a role card listed in AGENTS`);
    }
    if (Object.hasOwn(out, key)) throw new Error(`AGENT_DISPLAY_NAMES lists "${key}" more than once`);
    if (!LABEL_RE.test(label)) {
      throw new Error(`AGENT_DISPLAY_NAMES label for "${key}" must match ${LABEL_RE}`);
    }
    out[key] = label;
  });
  return out;
}

/** Build config from an env-like object. Throws with a clear message if insecure. */
function loadConfig(env = process.env) {
  const errors = [];
  const ingestToken = env.INGEST_TOKEN || '';
  const dashboardToken = env.DASHBOARD_TOKEN || '';
  for (const [name, val] of [
    ['INGEST_TOKEN', ingestToken],
    ['DASHBOARD_TOKEN', dashboardToken],
  ]) {
    const err = validateToken(name, val);
    if (err) errors.push(err);
  }
  if (ingestToken && ingestToken === dashboardToken) {
    errors.push('INGEST_TOKEN and DASHBOARD_TOKEN must be different secrets');
  }
  if (errors.length) {
    const e = new Error(`Refusing to start: ${errors.join('; ')}`);
    e.code = 'INSECURE_CONFIG';
    throw e;
  }
  const agents = (env.AGENTS || DEFAULT_AGENTS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const untracked = agents.filter((n) => UNTRACKED_AGENTS.includes(n));
  if (untracked.length) {
    console.warn(`WARNING: AGENTS contains untracked agents (${untracked.join(', ')}); ignoring them`);
  }
  return {
    ingestToken,
    dashboardToken,
    port: int(env, 'PORT', 8787, { min: 1 }),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || './data/dashboard.db',
    agents: agents.filter((n) => !UNTRACKED_AGENTS.includes(n)),
    agentNames: parseNames(env.AGENT_NAMES, agents),
    agentDisplayNames: parseDisplayNames(
      env.AGENT_DISPLAY_NAMES,
      agents.filter((n) => !UNTRACKED_AGENTS.includes(n)),
    ),
    agentCooldownSeconds: int(env, 'AGENT_COOLDOWN_SECONDS', 60, { min: 0 }),
    handoffWindowSeconds: int(env, 'HANDOFF_WINDOW_SECONDS', 120, { min: 0 }),
    retentionDays: int(env, 'RETENTION_DAYS', 30, { min: 1 }),
    maxRows: int(env, 'MAX_ROWS', 200000, { min: 1000 }),
    doneToIdleSeconds: int(env, 'DONE_TO_IDLE_SECONDS', 60, { min: 1 }),
    staleMinutes: int(env, 'STALE_MINUTES', 10, { min: 1 }),
    pipelineStaleMinutes: int(env, 'PIPELINE_STALE_MINUTES', 60, { min: 1 }),
    maxAttempts: int(env, 'MAX_ATTEMPTS', 3, { min: 1 }),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 64 * 1024, { min: 1024 }),
    sessionHours: int(env, 'SESSION_HOURS', 12, { min: 1 }),
    // Secure by default; plain-HTTP LAN use must opt out explicitly with COOKIE_SECURE=false.
    cookieSecure: env.COOKIE_SECURE !== 'false',
    trustProxy: env.TRUST_PROXY === 'true',
    maxAgents: int(env, 'MAX_AGENTS', 100, { min: 1 }),
    maxRuns: int(env, 'MAX_RUNS', 50, { min: 1 }),
    ingestRatePerMin: int(env, 'INGEST_RATE_PER_MIN', 600, { min: 1 }),
    maxSseClients: int(env, 'MAX_SSE_CLIENTS', 50, { min: 1 }),
    pricing: loadPricing(env.PRICING_FILE),
    // Optional hand-edited office layout served by GET /api/office-layout; unset means bundled only.
    officeLayoutPath: (env.OFFICE_LAYOUT_PATH || '').trim(),
    pruneIntervalMinutes: int(env, 'PRUNE_INTERVAL_MINUTES', 60, { min: 1 }),
  };
}

/** Non-fatal deployment warnings, printed once at startup. */
function startupWarnings(config) {
  const out = [];
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
  if (!config.cookieSecure && !loopback) {
    out.push(
      `COOKIE_SECURE=false while listening on ${config.host}: tokens and the session cookie cross the network in cleartext. Use TLS (COOKIE_SECURE=true) unless this is a trusted LAN.`,
    );
  }
  if (config.cookieSecure && !config.trustProxy) {
    out.push(
      'COOKIE_SECURE=true with TRUST_PROXY=false: behind a reverse proxy every client shares the proxy IP, so failed-login throttling is global. Set TRUST_PROXY=true when proxied. Secure cookies also do not work over plain HTTP (except localhost).',
    );
  }
  return out;
}

module.exports = { startupWarnings, loadConfig, validateToken, DEFAULT_AGENTS, DEFAULT_AGENT_NAMES };
