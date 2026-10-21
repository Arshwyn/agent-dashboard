'use strict';

const { cleanText, sanitizeMeta } = require('./redact');
const { TOKEN_CLASSES, emptyClasses } = require('./pricing');

const EVENT_TYPES = [
  'tool_start',
  'tool_end',
  'subagent_stop',
  'stop',
  'notification',
  'status',
  'pipeline',
  'link',
];
// A run id as sent by the orchestrator in a `run-id:` prompt line and in `link` event meta.
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SUBSTEP_NAMES = ['test', 'styling', 'security', 'code-review'];
const ID_RE = /^[A-Za-z0-9._:@/-]+$/;
const MAX_FUTURE_MS = 24 * 3600 * 1000;
const MAX_TOKENS = 1e10;
const MODEL_RE = /^[A-Za-z0-9._:@/-]{1,80}$/;
const MAX_MODELS = 20;
const USAGE_SCOPES = ['delta', 'session_cumulative'];

function fail(errors, msg) {
  errors.push(msg);
}

function parseTs(v, now) {
  let ms;
  if (typeof v === 'number' && Number.isFinite(v)) {
    ms = v < 1e12 ? Math.round(v * 1000) : Math.round(v); // seconds or ms
  } else if (typeof v === 'string' && v.length <= 40) {
    ms = /^\d+(\.\d+)?$/.test(v) ? parseTs(Number(v), now) : Date.parse(v);
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > now + MAX_FUTURE_MS) return null;
  return ms;
}

function idField(body, key, max, errors) {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !ID_RE.test(v)) {
    fail(errors, `${key} must be a string of 1-${max} chars matching ${ID_RE}`);
    return null;
  }
  return v;
}

function optText(body, key, max, errors) {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    fail(errors, `${key} must be a string`);
    return null;
  }
  return cleanText(v, max);
}

function optNum(body, key, errors, { int = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TOKENS) {
    fail(errors, `${key} must be a non-negative number`);
    return null;
  }
  return int ? Math.round(v) : v;
}

/**
 * Per-model usage: { <model id>: { input, output, cache_write_5m, cache_write_1h, cache_read } }.
 * Only these numeric classes are kept; any other key is dropped. Returns null (and records an
 * error) when malformed. An empty object counts as "no usage".
 */
function optUsage(body, errors) {
  const v = body.usage;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    fail(errors, 'usage must be an object keyed by model id');
    return null;
  }
  const entries = Object.entries(v);
  if (entries.length > MAX_MODELS) {
    fail(errors, `usage may list at most ${MAX_MODELS} models`);
    return null;
  }
  const out = {};
  for (const [model, classes] of entries) {
    if (!MODEL_RE.test(model) || cleanText(model, 80) !== model) {
      fail(errors, `usage model id must match ${MODEL_RE} and contain no secrets`);
      return null;
    }
    if (!classes || typeof classes !== 'object' || Array.isArray(classes)) {
      fail(errors, `usage.${model} must be an object`);
      return null;
    }
    const o = emptyClasses();
    for (const c of TOKEN_CLASSES) {
      const n = classes[c];
      if (n === undefined || n === null) continue;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_TOKENS) {
        fail(errors, `usage.${model}.${c} must be a non-negative number`);
        return null;
      }
      o[c] = Math.round(n);
    }
    out[model] = o;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate and sanitize an incoming event body. Only allow-listed fields are kept, so raw
 * tool_input / tool_response / file contents / command output sent by a client are dropped.
 * Returns { ok: true, event } or { ok: false, errors }.
 */
function validateEvent(body, now = Date.now()) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const ts = parseTs(body.ts, now);
  if (ts === null) fail(errors, 'ts must be an ISO-8601 string or epoch seconds/ms (not in the future)');
  const agent = idField(body, 'agent', 40, errors);
  const session_id = idField(body, 'session_id', 100, errors);
  const type = body.type;
  if (!EVENT_TYPES.includes(type)) fail(errors, `type must be one of: ${EVENT_TYPES.join(', ')}`);
  const tool = optText(body, 'tool', 64, errors);
  // Pipeline summaries (run start/end text) get a larger cap than hook-event summaries.
  const summary = optText(body, 'summary', type === 'pipeline' ? 400 : 200, errors);
  const task = optText(body, 'task', 200, errors);
  const repo = optText(body, 'repo', 100, errors);
  const branch = optText(body, 'branch', 120, errors);
  const tokens_in = optNum(body, 'tokens_in', errors, { int: true });
  const tokens_out = optNum(body, 'tokens_out', errors, { int: true });
  const cost_usd = optNum(body, 'cost_usd', errors);
  const usage = optUsage(body, errors);
  let usage_scope = null;
  if (body.usage_scope !== undefined && body.usage_scope !== null) {
    if (!USAGE_SCOPES.includes(body.usage_scope))
      fail(errors, `usage_scope must be one of: ${USAGE_SCOPES.join(', ')}`);
    else if (body.usage_scope === 'session_cumulative' && type !== 'stop')
      fail(errors, 'usage_scope session_cumulative is only valid on stop events');
    else usage_scope = body.usage_scope;
  }
  let meta = null;
  if (body.meta !== undefined && body.meta !== null) {
    if (typeof body.meta !== 'object' || Array.isArray(body.meta)) fail(errors, 'meta must be an object');
    else meta = sanitizeMeta(body.meta);
    // `substep` is an enum; anything else is dropped (not a 422) and the step is kept as sent.
    if (meta && 'substep' in meta && !SUBSTEP_NAMES.includes(meta.substep)) delete meta.substep;
  }
  if (type === 'link') {
    // A link ties a subagent session to a run: only `meta.run_id` is kept, validated before any redaction.
    const rid = body.meta && typeof body.meta === 'object' ? body.meta.run_id : undefined;
    if (typeof rid !== 'string' || !RUN_ID_RE.test(rid)) fail(errors, `meta.run_id must match ${RUN_ID_RE}`);
    else meta = { run_id: rid };
    const colon = session_id ? session_id.lastIndexOf(':') : -1;
    if (session_id && !(colon > 0 && colon < session_id.length - 1))
      fail(errors, 'link events need a subagent session_id');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    event: {
      ts,
      agent,
      session_id,
      type,
      tool,
      summary,
      task,
      repo,
      branch,
      tokens_in,
      tokens_out,
      cost_usd,
      usage,
      usage_scope,
      meta,
    },
  };
}

module.exports = { validateEvent, EVENT_TYPES, RUN_ID_RE };
