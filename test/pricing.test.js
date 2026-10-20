'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_PRICING,
  computeCost,
  modelCost,
  resolveRates,
  snapshotDelta,
  loadPricing,
  validatePricing,
} = require('../src/pricing');

const TABLE = {
  version: 't1',
  as_of: '2026-01-01',
  models: {
    'claude-x': { input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.3 },
    'claude-x-big': { input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 },
  },
};
const u = (o = {}) => ({ input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, ...o });

test('cost: each token class is priced at its own rate', () => {
  const M = 1_000_000;
  assert.equal(modelCost('claude-x', u({ input: M }), TABLE), 3);
  assert.equal(modelCost('claude-x', u({ output: M }), TABLE), 15);
  assert.equal(modelCost('claude-x', u({ cache_write_5m: M }), TABLE), 3.75);
  assert.equal(modelCost('claude-x', u({ cache_write_1h: M }), TABLE), 6);
  assert.equal(modelCost('claude-x', u({ cache_read: M }), TABLE), 0.3);
  assert.equal(modelCost('claude-x', u(), TABLE), 0);
});

test('cost: sums models, rounds to 9 decimals, and zero usage is zero', () => {
  const r = computeCost({ 'claude-x': u({ input: 1 }), 'claude-x-big': u({ output: 1 }) }, TABLE);
  assert.equal(r.cost_usd, 0.000053);
  assert.equal(r.unpriced_tokens, 0);
  assert.deepEqual(computeCost({}, TABLE), {
    cost_usd: 0,
    unpriced_tokens: 0,
    unknown_models: [],
    per_model: {},
  });
  assert.deepEqual(computeCost(null, TABLE).unknown_models, []);
});

test('cost: unknown model is never priced as zero or guessed, it is reported as unpriced', () => {
  const r = computeCost(
    { 'claude-x': u({ input: 1_000_000 }), 'gpt-9': u({ input: 10, output: 5, cache_read: 1 }) },
    TABLE,
  );
  assert.equal(r.cost_usd, 3);
  assert.equal(r.unpriced_tokens, 16);
  assert.deepEqual(r.unknown_models, ['gpt-9']);
  assert.equal(r.per_model['gpt-9'], null);
  assert.equal(resolveRates(undefined, TABLE), null);
  assert.equal(resolveRates('unknown', TABLE), null);
});

test('model matching: prefix, longest prefix wins, dated ids and case', () => {
  assert.equal(resolveRates('claude-x-20250929', TABLE).input, 3);
  assert.equal(resolveRates('claude-x-big-20250929', TABLE).input, 10);
  assert.equal(resolveRates('CLAUDE-X', TABLE).input, 3);
  assert.equal(resolveRates('claude-sonnet-4-5-20250929').input, 3);
  assert.equal(resolveRates('claude-opus-5-5').input, 4);
  assert.equal(resolveRates('claude-opus-5-20260101').input, 5);
  assert.equal(resolveRates('claude-sonnet-5-5').input, 2);
  assert.equal(resolveRates('claude-haiku-4-5-20251001').output, 5);
  assert.ok(DEFAULT_PRICING.version && DEFAULT_PRICING.as_of);
});

test('model matching: ids only match on a boundary, otherwise they are unpriced', () => {
  assert.equal(resolveRates('claude-opus-4-10'), null);
  assert.equal(resolveRates('claude-opus-5-50'), null);
  assert.equal(resolveRates('claude-sonnet-4-50'), null);
  assert.equal(resolveRates('claude-opus-4-1x'), null);
  assert.equal(resolveRates('claude-opus-4-1').input, 15);
  assert.equal(resolveRates('claude-opus-4-1-20250805').input, 15);
  assert.equal(resolveRates('claude-opus-4-20250514').input, 15);
  assert.equal(resolveRates('claude-opus-4-0').input, 15);
  assert.equal(resolveRates('claude-opus-5-5-20260101').input, 4);
  assert.equal(resolveRates('claude-sonnet-4-5-20250929').input, 3);
  assert.equal(resolveRates('claude-3-5-haiku-latest').input, 0.8);
  assert.equal(resolveRates('claude-opus-4-8[1m]').input, 5);
  assert.equal(computeCost({ 'claude-opus-4-10': u({ input: 7 }) }).unpriced_tokens, 7);
  assert.deepEqual(computeCost({ 'claude-opus-4-10': u({ input: 7 }) }).unknown_models, ['claude-opus-4-10']);
});

test('model rates: Fable 5 vs 5.1 cache reads differ, longest key wins', () => {
  assert.equal(resolveRates('claude-fable-5').cache_read, 1);
  assert.equal(resolveRates('claude-mythos-5').cache_read, 1);
  assert.equal(resolveRates('claude-fable-5-1').cache_read, 0.25);
  assert.equal(resolveRates('claude-mythos-5-1').cache_read, 0.25);
  assert.equal(resolveRates('claude-haiku-5-5').input, 0.1);
  assert.equal(resolveRates('claude-haiku-5'), null);
  assert.equal(resolveRates('claude-sonnet-5-5').cache_read, 0.1);
  assert.equal(resolveRates('claude-sonnet-5').cache_read, 0.2);
  assert.equal(resolveRates('claude-opus-5-5').cache_read, 0.2);
  assert.equal(resolveRates('claude-3-opus'), null);
  assert.equal(resolveRates('claude-3-haiku-20240307'), null);
});

test('snapshotDelta: growth, identical, shrink resets, vanished model resets, never negative', () => {
  const s1 = { m: u({ input: 10, output: 5 }) };
  const s2 = { m: u({ input: 15, output: 5, cache_read: 3 }), n: u({ input: 1 }) };
  assert.deepEqual(snapshotDelta(null, s1), { delta: s1, reset: false });
  const d = snapshotDelta(s1, s2);
  assert.equal(d.reset, false);
  assert.deepEqual(d.delta, { m: u({ input: 5, cache_read: 3 }), n: u({ input: 1 }) });
  assert.deepEqual(snapshotDelta(s2, s2), { delta: {}, reset: false });
  const shrink = snapshotDelta(s2, { m: u({ input: 2 }), n: u({ input: 1 }) });
  assert.equal(shrink.reset, true);
  assert.deepEqual(shrink.delta, { m: u({ input: 2 }), n: u({ input: 1 }) });
  const gone = snapshotDelta(s2, { m: s2.m });
  assert.equal(gone.reset, true);
});

test('PRICING_FILE: loads a valid table and rejects malformed ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-price-'));
  try {
    const good = path.join(dir, 'p.json');
    fs.writeFileSync(good, JSON.stringify(TABLE));
    assert.equal(loadPricing(good).version, 't1');
    assert.equal(loadPricing(''), DEFAULT_PRICING);
    const bad = path.join(dir, 'b.json');
    fs.writeFileSync(bad, '{"version":"x"}');
    assert.throws(() => loadPricing(bad), /as_of/);
    assert.throws(() => loadPricing(path.join(dir, 'missing.json')), /PRICING_FILE/);
    assert.throws(() => validatePricing({ ...TABLE, models: { a: { input: -1 } } }), /non-negative|must be/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
