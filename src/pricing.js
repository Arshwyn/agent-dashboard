'use strict';

const fs = require('node:fs');

/**
 * Static, versioned pricing table (USD per 1M tokens) and the pure cost function.
 *
 * Rates are copied per model from https://platform.claude.com/docs/en/about-claude/pricing as of
 * `as_of` (cache write 5m/1h and cache read are the listed per-model rates, not derived from
 * multipliers: cache read is 0.1x input except 0.025x on Fable/Mythos 5.1 and 0.05x on Opus/Sonnet
 * 5.5). Only models the page lists are kept. Claude Haiku 5.5 has a second, higher tier for prompts
 * over 100,000 tokens (5x on every class); it is not modelled because usage is aggregated per
 * session and model, without per-request prompt length, so the table holds the up-to-100K rates. Bump `version` whenever a rate
 * changes: every stored event records the version it was priced with. Operators can replace the
 * whole table with PRICING_FILE (same JSON shape, see README).
 */
const TOKEN_CLASSES = ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read'];

const r = (input, output, cache_write_5m, cache_write_1h, cache_read) => ({
  input,
  output,
  cache_write_5m,
  cache_write_1h,
  cache_read,
});

const DEFAULT_PRICING = {
  version: '2026-10-19.3',
  as_of: '2026-10-19',
  // Keys are model ids. An id matches a key when it equals it or continues with a date
  // (-YYYYMMDD), -latest, and/or a [1m] marker, so claude-sonnet-4-5-20250929 resolves to
  // claude-sonnet-4-5 but claude-opus-4-10 does not resolve to claude-opus-4-1 (unpriced instead).
  // The longest matching key wins.
  models: {
    'claude-fable-5-1': r(10, 50, 12.5, 20, 0.25),
    'claude-mythos-5-1': r(10, 50, 12.5, 20, 0.25),
    'claude-fable-5': r(10, 50, 12.5, 20, 1),
    'claude-mythos-5': r(10, 50, 12.5, 20, 1),
    'claude-opus-5-5': r(4, 20, 5, 8, 0.2),
    'claude-opus-5': r(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-8': r(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-7': r(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-6': r(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-5': r(5, 25, 6.25, 10, 0.5),
    'claude-opus-4-1': r(15, 75, 18.75, 30, 1.5),
    'claude-opus-4-0': r(15, 75, 18.75, 30, 1.5),
    'claude-opus-4': r(15, 75, 18.75, 30, 1.5),
    'claude-sonnet-5-5': r(2, 10, 2.5, 4, 0.1),
    'claude-sonnet-5': r(2, 10, 2.5, 4, 0.2),
    'claude-sonnet-4-6': r(3, 15, 3.75, 6, 0.3),
    'claude-sonnet-4-5': r(3, 15, 3.75, 6, 0.3),
    'claude-sonnet-4-0': r(3, 15, 3.75, 6, 0.3),
    'claude-sonnet-4': r(3, 15, 3.75, 6, 0.3),
    'claude-haiku-5-5': r(0.1, 0.5, 0.125, 0.2, 0.01),
    'claude-haiku-4-5': r(1, 5, 1.25, 2, 0.1),
    'claude-3-5-haiku': r(0.8, 4, 1, 1.6, 0.08),
  },
};

function emptyClasses() {
  return { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };
}

/** Validate a pricing table (from PRICING_FILE). Throws a descriptive Error. */
function validatePricing(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('pricing must be a JSON object');
  if (typeof t.version !== 'string' || !t.version) throw new Error('pricing.version must be a string');
  if (typeof t.as_of !== 'string' || !t.as_of) throw new Error('pricing.as_of must be a string');
  if (!t.models || typeof t.models !== 'object' || Array.isArray(t.models) || !Object.keys(t.models).length) {
    throw new Error('pricing.models must be a non-empty object');
  }
  for (const [k, rates] of Object.entries(t.models)) {
    if (!rates || typeof rates !== 'object') throw new Error(`pricing.models.${k} must be an object`);
    for (const c of TOKEN_CLASSES) {
      if (typeof rates[c] !== 'number' || !Number.isFinite(rates[c]) || rates[c] < 0) {
        throw new Error(`pricing.models.${k}.${c} must be a non-negative number`);
      }
    }
  }
  return t;
}

/** Load PRICING_FILE if given, else the built-in table. */
function loadPricing(file) {
  if (!file) return DEFAULT_PRICING;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`PRICING_FILE could not be read as JSON (${e.code || e.name})`);
  }
  return validatePricing(parsed);
}

// What may follow a table key: nothing, a date, or -latest, optionally with a [1m] context marker.
const ID_SUFFIX = /^(?:-\d{8}|-latest)?(?:\[1m\])?$/;

/** Rates for a model id (longest key match on a boundary), or null if unknown. */
function resolveRates(model, table = DEFAULT_PRICING) {
  if (typeof model !== 'string') return null;
  const id = model.toLowerCase();
  let best = null;
  for (const prefix of Object.keys(table.models)) {
    if (
      id.startsWith(prefix) &&
      ID_SUFFIX.test(id.slice(prefix.length)) &&
      (best === null || prefix.length > best.length)
    )
      best = prefix;
  }
  return best === null ? null : table.models[best];
}

const round9 = (n) => Math.round(n * 1e9) / 1e9;

/** Cost of one model's token classes, or null when the model is unknown. Pure. */
function modelCost(model, classes, table = DEFAULT_PRICING) {
  const rates = resolveRates(model, table);
  if (!rates) return null;
  let sum = 0;
  for (const c of TOKEN_CLASSES) sum += ((classes[c] || 0) / 1e6) * rates[c];
  return round9(sum);
}

function classTotal(classes) {
  let n = 0;
  for (const c of TOKEN_CLASSES) n += classes[c] || 0;
  return n;
}

/**
 * Pure cost function. `usage` is { <model>: { input, output, cache_write_5m, cache_write_1h,
 * cache_read } }. Unknown models are never priced as $0 or guessed: their tokens are counted in
 * `unpriced_tokens` and the model id is listed in `unknown_models`.
 */
function computeCost(usage, table = DEFAULT_PRICING) {
  let cost = 0;
  let unpriced = 0;
  const unknown = [];
  const per_model = {};
  for (const [model, classes] of Object.entries(usage || {})) {
    const c = modelCost(model, classes, table);
    per_model[model] = c;
    if (c === null) {
      unpriced += classTotal(classes);
      unknown.push(model);
    } else cost += c;
  }
  return { cost_usd: round9(cost), unpriced_tokens: unpriced, unknown_models: unknown, per_model };
}

/**
 * Delta between two cumulative per-model snapshots. If any class went down (resumed, compacted,
 * cleared or rewritten transcript) the new snapshot is a new baseline and is counted in full.
 * Never returns a negative number.
 */
function snapshotDelta(prev, next) {
  const clone = (u) => {
    const out = {};
    for (const [m, c] of Object.entries(u || {})) {
      const o = emptyClasses();
      for (const k of TOKEN_CLASSES) o[k] = c[k] || 0;
      if (classTotal(o) > 0) out[m] = o;
    }
    return out;
  };
  if (!prev) return { delta: clone(next), reset: false };
  for (const [m, c] of Object.entries(prev)) {
    for (const k of TOKEN_CLASSES) {
      if (((next && next[m] && next[m][k]) || 0) < (c[k] || 0)) return { delta: clone(next), reset: true };
    }
  }
  const delta = {};
  for (const [m, c] of Object.entries(next || {})) {
    const o = emptyClasses();
    for (const k of TOKEN_CLASSES) o[k] = (c[k] || 0) - ((prev[m] && prev[m][k]) || 0);
    if (classTotal(o) > 0) delta[m] = o;
  }
  return { delta, reset: false };
}

module.exports = {
  TOKEN_CLASSES,
  DEFAULT_PRICING,
  emptyClasses,
  classTotal,
  validatePricing,
  loadPricing,
  resolveRates,
  modelCost,
  computeCost,
  snapshotDelta,
};
