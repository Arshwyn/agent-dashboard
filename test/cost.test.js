'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDb } = require('../src/db');
const { validateEvent } = require('../src/schema');
const { priceEvent, aggregateSessions, aggregateCosts } = require('../src/cost');
const { DEFAULT_PRICING, computeCost, TOKEN_CLASSES } = require('../src/pricing');
const { startApp, post, authed, ev, INGEST, DASH } = require('./helpers');

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const MIN = 60_000;
const u = (o = {}) => ({ input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, ...o });

/** Same path as POST /event: validate, price, store. */
function ingest(store, body, pricing = DEFAULT_PRICING) {
  const r = validateEvent(
    { agent: 'orchestrator', session_id: 'S', type: 'stop', ...body },
    NOW + 365 * 86400000,
  );
  assert.ok(r.ok, JSON.stringify(r.errors));
  return store.insertEvent(priceEvent(r.event, { store, pricing }));
}
const snap = (ts, usage, extra = {}) =>
  ingest(openStores.at(-1), { ts, usage, usage_scope: 'session_cumulative', ...extra });
const openStores = [];
function mem() {
  const s = openDb(':memory:');
  openStores.push(s);
  return s;
}
function sumRows(rows, sid = 'S') {
  const t = {};
  for (const r of rows.filter((x) => x.session_id === sid)) {
    for (const [m, c] of Object.entries(r.usage || {})) {
      t[m] = t[m] || u();
      for (const k of TOKEN_CLASSES) t[m][k] += c[k];
    }
  }
  return t;
}

test.afterEach(() => {
  while (openStores.length) openStores.pop().close();
});

const S1 = { 'claude-opus-5-5': u({ input: 100, output: 10, cache_read: 1000 }) };
const S2 = {
  'claude-opus-5-5': u({ input: 150, output: 40, cache_write_5m: 200, cache_read: 1500 }),
  'claude-haiku-4-5': u({ input: 7 }),
};
const S3 = {
  'claude-opus-5-5': u({ input: 400, output: 90, cache_write_5m: 200, cache_write_1h: 50, cache_read: 3000 }),
  'claude-haiku-4-5': u({ input: 20, output: 5 }),
};

test('(a) the same cumulative snapshot sent twice adds zero', () => {
  mem();
  const store = openStores[0];
  const first = snap(NOW, S1);
  const again = snap(NOW + MIN, S1);
  assert.equal(first.cost_usd > 0, true);
  assert.deepEqual(again.usage, {});
  assert.equal(again.cost_usd, 0);
  assert.equal(again.tokens_in, 0);
  const rows = store.listEvents({ limit: 10 });
  assert.deepEqual(sumRows(rows)['claude-opus-5-5'], S1['claude-opus-5-5']);
});

test('(b) growing snapshots S1<S2<S3 sum to S3 exactly, per model and per class', () => {
  mem();
  const store = openStores[0];
  snap(NOW, S1);
  snap(NOW + MIN, S2);
  snap(NOW + 2 * MIN, S3);
  const total = sumRows(store.listEvents({ limit: 10 }));
  assert.deepEqual(total, S3);
  const cost = store.listEvents({ limit: 10 }).reduce((a, r) => a + r.cost_usd, 0);
  assert.ok(Math.abs(cost - computeCost(S3).cost_usd) < 1e-9);
});

test('(c) a shrinking or rewritten transcript is a new baseline, counted in full, never negative', () => {
  mem();
  const store = openStores[0];
  snap(NOW, S3);
  const reset = snap(NOW + MIN, S1); // compacted / resumed: every class is lower
  assert.equal(reset.meta.baseline_reset, true);
  assert.deepEqual(sumRows([reset])['claude-opus-5-5'], S1['claude-opus-5-5']);
  for (const r of store.listEvents({ limit: 10 })) {
    for (const c of Object.values(r.usage || {})) for (const k of TOKEN_CLASSES) assert.ok(c[k] >= 0);
  }
  // and the new baseline is S1: growing from it yields only the difference
  const next = snap(NOW + 2 * MIN, S2);
  assert.equal(next.meta?.baseline_reset, undefined);
  assert.equal(next.usage['claude-opus-5-5'].input, 50);
  assert.equal(next.usage['claude-haiku-4-5'].input, 7);
  // a single lowered class is enough, even if others grew
  const partial = snap(NOW + 3 * MIN, {
    'claude-opus-5-5': u({ input: 9999, output: 1 }),
    'claude-haiku-4-5': S2['claude-haiku-4-5'],
  });
  assert.equal(partial.meta.baseline_reset, true);
});

test('(d) an older snapshot arriving after a newer one adds nothing and keeps the baseline', () => {
  mem();
  const store = openStores[0];
  snap(NOW + 2 * MIN, S3);
  const late = snap(NOW + MIN, S1);
  assert.deepEqual(late.usage, {});
  assert.equal(late.meta.stale_snapshot, true);
  assert.equal(late.cost_usd, 0);
  const same = snap(NOW + 3 * MIN, S3);
  assert.deepEqual(same.usage, {});
  assert.deepEqual(sumRows(store.listEvents({ limit: 10 })), S3);
});

test('(e) a server restart between Stops does not double-count (state rebuilt from the DB)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cost-'));
  try {
    const file = path.join(dir, 'd.db');
    let store = openDb(file);
    ingest(store, { ts: NOW, usage: S2, usage_scope: 'session_cumulative' });
    store.close();
    store = openDb(file);
    openStores.push(store);
    const r = ingest(store, { ts: NOW + MIN, usage: S3, usage_scope: 'session_cumulative' });
    const dup = ingest(store, { ts: NOW + 2 * MIN, usage: S3, usage_scope: 'session_cumulative' });
    assert.deepEqual(dup.usage, {});
    assert.equal(r.usage['claude-opus-5-5'].input, 250);
    assert.deepEqual(sumRows(store.listEvents({ limit: 10 })), S3);
  } finally {
    openStores.length = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(f) interleaved sessions do not affect each other', () => {
  mem();
  const store = openStores[0];
  const A = { 'claude-opus-5-5': u({ input: 10 }) };
  const B = { 'claude-opus-5-5': u({ input: 500 }) };
  ingest(store, { ts: NOW, session_id: 'A', usage: A, usage_scope: 'session_cumulative' });
  ingest(store, { ts: NOW + 1, session_id: 'B', usage: B, usage_scope: 'session_cumulative' });
  const a2 = ingest(store, {
    ts: NOW + 2,
    session_id: 'A',
    usage: { 'claude-opus-5-5': u({ input: 30 }) },
    usage_scope: 'session_cumulative',
  });
  const b2 = ingest(store, { ts: NOW + 3, session_id: 'B', usage: B, usage_scope: 'session_cumulative' });
  assert.equal(a2.usage['claude-opus-5-5'].input, 20);
  assert.equal(a2.meta?.baseline_reset, undefined);
  assert.deepEqual(b2.usage, {});
  const rows = store.listEvents({ limit: 10 });
  assert.equal(sumRows(rows, 'A')['claude-opus-5-5'].input, 30);
  assert.equal(sumRows(rows, 'B')['claude-opus-5-5'].input, 500);
});

test('(g) the stored cost equals the pure function applied to the stored raw tokens', () => {
  mem();
  const store = openStores[0];
  const row = ingest(store, { ts: NOW, usage: S3, usage_scope: 'session_cumulative' });
  const raw = Object.fromEntries(
    Object.entries(row.usage).map(([m, c]) => [m, Object.fromEntries(TOKEN_CLASSES.map((k) => [k, c[k]]))]),
  );
  assert.equal(row.cost_usd, computeCost(raw, DEFAULT_PRICING).cost_usd);
  assert.equal(row.cost_source, 'computed');
  assert.equal(row.pricing_version, DEFAULT_PRICING.version);
  assert.equal(row.tokens_in, 400 + 200 + 50 + 20);
  assert.equal(row.tokens_out, 95);
  assert.equal(row.snapshot, undefined, 'the cumulative snapshot is never exposed');
  const stored = store.listEvents({ limit: 1 })[0];
  assert.deepEqual(stored.usage, row.usage);
});

test('precedence: computed cost wins; sender cost only for legacy events; neither is unpriced', () => {
  mem();
  const store = openStores[0];
  const both = ingest(store, { type: 'subagent_stop', ts: NOW, usage: S1, cost_usd: 999, tokens_in: 1 });
  assert.equal(both.cost_source, 'computed');
  assert.equal(both.cost_usd, computeCost(S1).cost_usd);
  const legacy = ingest(store, {
    type: 'subagent_stop',
    ts: NOW,
    tokens_in: 100,
    tokens_out: 5,
    cost_usd: 0.25,
  });
  assert.equal(legacy.cost_source, 'reported');
  assert.equal(legacy.cost_usd, 0.25);
  assert.equal(legacy.unpriced_tokens, 0);
  const none = ingest(store, { type: 'subagent_stop', ts: NOW, tokens_in: 100, tokens_out: 5 });
  assert.equal(none.cost_source, null);
  assert.equal(none.cost_usd, null);
  assert.equal(none.unpriced_tokens, 105);
});

test('unknown models: partly priced, flagged with the unpriced token count, and reported once', () => {
  mem();
  const store = openStores[0];
  const seen = [];
  const r = validateEvent({
    ts: NOW,
    agent: 'code',
    session_id: 'X',
    type: 'subagent_stop',
    usage: { 'claude-opus-5-5': u({ input: 10 }), 'mystery-1': u({ input: 3, output: 4, cache_read: 5 }) },
  });
  const row = store.insertEvent(
    priceEvent(r.event, { store, pricing: DEFAULT_PRICING, onUnknownModel: (m) => seen.push(m) }),
  );
  assert.deepEqual(seen, ['mystery-1']);
  assert.equal(row.unpriced_tokens, 12);
  assert.equal(row.usage['mystery-1'].cost_usd, null);
  assert.equal(row.cost_usd, computeCost({ 'claude-opus-5-5': u({ input: 10 }) }).cost_usd);
  const [s] = aggregateSessions(store.usageEventsFrom(0));
  assert.equal(s.cost_incomplete, true);
  assert.equal(s.unpriced_tokens, 12);
  assert.equal(s.models.find((m) => m.model === 'mystery-1').priced, false);
});

test('schema: new usage fields validate; old senders still do', () => {
  const base = { ts: NOW, agent: 'code', session_id: 's', type: 'subagent_stop' };
  const now = NOW + 1000;
  assert.ok(validateEvent({ ...base, tokens_in: 1, tokens_out: 2, cost_usd: 0.1 }, now).ok);
  const good = validateEvent(
    { ...base, usage: { 'claude-opus-5-5': { input: 1.4, output: 2, extra: 5 } } },
    now,
  );
  assert.ok(good.ok);
  assert.deepEqual(good.event.usage['claude-opus-5-5'], u({ input: 1, output: 2 }));
  assert.equal(validateEvent({ ...base, usage: {} }, now).event.usage, null);
  const bad = [
    { usage: [] },
    { usage: { 'bad model': { input: 1 } } },
    { usage: { m: { input: -1 } } },
    { usage: { m: { input: 'x' } } },
    { usage: { m: { input: 1e12 } } },
    { usage: { m: 5 } },
    { usage: { ['x'.repeat(81)]: { input: 1 } } },
    { usage: { m: { input: 1 } }, usage_scope: 'weird' },
    { usage: { m: { input: 1 } }, usage_scope: 'session_cumulative' }, // not a stop event
    { usage: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, { input: 1 }])) },
  ];
  for (const b of bad)
    assert.equal(validateEvent({ ...base, ...b }, now).ok, false, JSON.stringify(b).slice(0, 80));
  assert.ok(
    validateEvent(
      { ...base, type: 'stop', usage: { m: { input: 1 } }, usage_scope: 'session_cumulative' },
      now,
    ).ok,
  );
});

test('DB migration: adds the new columns to a pre-existing database, idempotently, keeping rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mig-'));
  try {
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL,
      session_id TEXT NOT NULL, type TEXT NOT NULL, tool TEXT, summary TEXT, task TEXT, repo TEXT, branch TEXT,
      tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, meta TEXT);`);
    old
      .prepare(
        "INSERT INTO events (ts, agent, session_id, type, tokens_in, tokens_out) VALUES (?, 'code', 'old', 'subagent_stop', 10, 2)",
      )
      .run(NOW);
    old.close();
    for (let i = 0; i < 2; i++) {
      const store = openDb(file); // second open must not fail
      const rows = store.listEvents({ limit: 5 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tokens_in, 10);
      assert.equal(rows[0].usage, null);
      assert.equal(rows[0].cost_source, null);
      store.close();
    }
    const store = openDb(file);
    const row = ingest(store, { ts: NOW + 1, type: 'subagent_stop', usage: S1 });
    assert.equal(row.cost_source, 'computed');
    // historical row stays unpriced and is flagged, never backfilled
    const [hist] = aggregateSessions(store.usageEventsFrom(0)).filter((s) => s.session_id === 'old');
    assert.equal(hist.cost_usd, 0);
    assert.equal(hist.cost_incomplete, true);
    assert.equal(hist.unpriced_tokens, 12);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregation: sessions roll subagents up to the parent; period totals by model, agent and day', () => {
  mem();
  const store = openStores[0];
  const day = 86400000;
  ingest(store, {
    agent: 'code',
    session_id: 'P:agent1',
    type: 'subagent_stop',
    ts: NOW - 2 * day,
    repo: 'r',
    usage: S1,
  });
  ingest(store, { agent: 'test', session_id: 'P:agent2', type: 'subagent_stop', ts: NOW, usage: S2 });
  ingest(store, {
    agent: 'orchestrator',
    session_id: 'P',
    ts: NOW,
    usage: S1,
    usage_scope: 'session_cumulative',
  });
  ingest(store, { agent: 'code', session_id: 'Q', type: 'subagent_stop', ts: NOW - 20 * day, usage: S1 });
  const rows = store.usageEventsFrom(0);
  const sessions = aggregateSessions(rows, { limit: 10 });
  assert.deepEqual(
    sessions.map((s) => s.session_id),
    ['P', 'Q'],
  );
  const p = sessions[0];
  assert.deepEqual(p.agents, ['code', 'orchestrator', 'test']);
  assert.equal(p.subagent_sessions, 2);
  assert.equal(p.repo, 'r');
  assert.equal(p.first_ts, NOW - 2 * day);
  const expected = computeCost(S1).cost_usd * 2 + computeCost(S2).cost_usd;
  assert.ok(Math.abs(p.cost_usd - expected) < 1e-6);
  assert.equal(p.tokens.input, 100 + 150 + 100 + 7);
  assert.equal(aggregateSessions(rows, { limit: 1 }).length, 1);

  const c = aggregateCosts(rows, { days: 7, now: NOW, retentionDays: 30, pricing: DEFAULT_PRICING });
  assert.equal(c.sessions, 1, 'Q is outside the 7-day window');
  assert.equal(c.by_day.length, 7);
  assert.equal(c.by_day.at(-1).day, '2026-10-19');
  assert.equal(c.today.day, '2026-10-19');
  assert.ok(Math.abs(c.total.cost_usd - expected) < 1e-6);
  assert.equal(c.by_day.reduce((a, d) => a + d.cost_usd, 0).toFixed(6), c.total.cost_usd.toFixed(6));
  assert.deepEqual(c.by_agent.map((a) => a.agent).sort(), ['code', 'orchestrator', 'test']);
  assert.equal(c.by_model.find((m) => m.model === 'claude-opus-5-5').tokens.input, 100 + 150 + 100);
  assert.equal(c.window.days, 7);
  assert.equal(c.pricing.version, DEFAULT_PRICING.version);
  assert.equal(c.total.cost_incomplete, false);
  const wide = aggregateCosts(rows, { days: 30, now: NOW, retentionDays: 30, pricing: DEFAULT_PRICING });
  assert.equal(wide.sessions, 2);
});

test('HTTP: ingest prices events; /api/sessions and /api/costs need the dashboard token', async () => {
  const t = await startApp();
  try {
    const now = Date.now();
    const body = (over) =>
      ev({
        agent: 'orchestrator',
        session_id: 'sid1',
        type: 'stop',
        usage_scope: 'session_cumulative',
        ...over,
      });
    assert.equal((await post(t.base, body({ ts: now - 2000, usage: S1 }))).status, 201);
    assert.equal((await post(t.base, body({ ts: now - 1000, usage: S1, cost_usd: 77 }))).status, 201);
    assert.equal((await post(t.base, body({ ts: now, usage: S2 }))).status, 201);
    assert.equal((await post(t.base, body({ ts: now, usage: S2, usage_scope: 'bogus' }))).status, 400);

    for (const p of ['/api/sessions', '/api/costs']) {
      assert.equal((await fetch(t.base + p)).status, 401);
      assert.equal((await fetch(t.base + p, authed(INGEST))).status, 401, 'ingest token cannot read');
    }
    const s = await (await fetch(`${t.base}/api/sessions?limit=1000`, authed(DASH))).json();
    assert.equal(s.sessions.length, 1);
    const sess = s.sessions[0];
    assert.equal(sess.session_id, 'sid1');
    assert.ok(Math.abs(sess.cost_usd - computeCost(S2).cost_usd) < 1e-6);
    assert.equal(sess.tokens.cache_read, 1500);
    assert.equal(sess.cost_incomplete, false);
    assert.ok(sess.models.length === 2);

    const c = await (await fetch(`${t.base}/api/costs?days=3`, authed(DASH))).json();
    assert.equal(c.window.days, 3);
    assert.equal(c.by_day.length, 3);
    assert.equal(c.sessions, 1);
    assert.ok(Math.abs(c.total.cost_usd - computeCost(S2).cost_usd) < 1e-6);
    const capped = await (await fetch(`${t.base}/api/costs?days=9999`, authed(DASH))).json();
    assert.equal(capped.window.days, t.config.retentionDays);

    // the agent card shows the computed cost, consistent with the session total
    const a = (await (await fetch(`${t.base}/api/agents`, authed(DASH))).json()).agents.find(
      (x) => x.id === 'orchestrator',
    );
    assert.ok(Math.abs(a.cost_usd - computeCost(S2).cost_usd) < 1e-6);
    // events API never leaks the raw snapshot
    const evs = (await (await fetch(`${t.base}/api/events?limit=10`, authed(DASH))).json()).events;
    assert.ok(evs.every((e) => !('snapshot' in e)));
  } finally {
    await t.stop();
  }
});
