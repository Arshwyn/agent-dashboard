'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeES {
  static last = null;
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.readyState = 0;
    FakeES.last = this;
  }
  addEventListener(n, fn) {
    this.listeners[n] = fn;
  }
  close() {
    this.readyState = 2;
  }
  fire(n, data) {
    this.listeners[n]({ data: JSON.stringify(data) });
  }
}

const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

test('client store normalizes agents, dedupes events, tracks connection and resyncs after reconnect', async () => {
  const { createStore } = await import('../public/js/store.js');
  let resyncs = 0;
  const fetchFn = (url) => {
    if (url.startsWith('/api/agents')) {
      resyncs++;
      return json({
        now: Date.now() + 5000,
        agents: [{ id: 'code', status: 'idle', current_task: null, tokens: { in: 0, out: 0 } }],
      });
    }
    if (url.startsWith('/api/events'))
      return json({ events: [{ id: 2, agent: 'code', type: 'stop' }], next_before: null });
    return json({ run: null, recent_runs: [] });
  };
  const store = createStore({ fetchFn, EventSourceCtor: FakeES });
  const seen = [];
  store.subscribe((_s, what) => seen.push(what));
  await store.start();
  assert.equal(store.state.agents[0].task, null);
  assert.ok(store.now() - Date.now() >= 4000, 'server clock skew applied');
  const es = FakeES.last;
  es.onopen();
  assert.equal(store.state.connection, 'live');
  es.fire('event', { id: 3, agent: 'code', type: 'tool_start' });
  es.fire('event', { id: 3, agent: 'code', type: 'tool_start' });
  assert.deepEqual(
    store.state.events.map((e) => e.id),
    [3, 2],
  );
  es.fire('agent', { id: 'code', status: 'working', current_task: 'Build', tokens: { in: 1, out: 2 } });
  assert.equal(store.state.agents[0].status, 'working');
  assert.equal(store.state.agents[0].task, 'Build');
  es.onerror();
  assert.equal(store.state.connection, 'reconnecting');
  const before = resyncs;
  es.onopen();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resyncs, before + 1);
  assert.equal(store.state.connection, 'live');
  store.stop();
});

test('client store keeps activity_runs from the initial fetch and SSE, and tolerates old servers', async () => {
  const { createStore } = await import('../public/js/store.js');
  const row = { run_id: 'q', kind: 'question', state: 'active', target: 'example-app', summary: 's' };
  let body = { run: null, recent_runs: [], activity_runs: [row] };
  const fetchFn = (url) => {
    if (url.startsWith('/api/agents')) return json({ now: Date.now(), agents: [] });
    if (url.startsWith('/api/events')) return json({ events: [], next_before: null });
    return json(body);
  };
  const store = createStore({ fetchFn, EventSourceCtor: FakeES });
  assert.deepEqual(store.state.pipeline.activity_runs, []);
  const seen = [];
  store.subscribe((_s, what) => seen.push(what));
  await store.start();
  assert.deepEqual(store.state.pipeline.activity_runs, [row]);
  FakeES.last.fire('pipeline', { run: null, recent_runs: [], activity_runs: [{ ...row, state: 'passed' }] });
  assert.equal(store.state.pipeline.activity_runs[0].state, 'passed');
  assert.ok(seen.includes('pipeline'));
  FakeES.last.fire('pipeline', { run: null, recent_runs: [] });
  assert.deepEqual(store.state.pipeline.activity_runs, []);
  body = { run: null, recent_runs: [] };
  await store.resync();
  assert.deepEqual(store.state.pipeline.activity_runs, []);
  store.stop();
});

test('client store loads costs and sessions, refreshes on usage events, and keeps data on errors', async () => {
  const { createStore } = await import('../public/js/store.js');
  let fail = false;
  let costCalls = 0;
  const summary = { total: { cost_usd: 1.5 }, window: { days: 7 }, by_model: [], by_agent: [], by_day: [] };
  const fetchFn = (url) => {
    if (url.startsWith('/api/agents')) return json({ now: Date.now(), agents: [] });
    if (url.startsWith('/api/events')) return json({ events: [], next_before: null });
    if (url.startsWith('/api/costs')) {
      costCalls++;
      if (fail) return Promise.reject(new Error('boom'));
      return json({ ...summary, requested: url });
    }
    if (url.startsWith('/api/sessions')) return json({ sessions: [{ session_id: 's', cost_usd: 1.5 }] });
    return json({ run: null, recent_runs: [] });
  };
  const store = createStore({ fetchFn, EventSourceCtor: FakeES });
  assert.equal(store.state.costs.summary, null);
  const seen = [];
  store.subscribe((_s, what) => seen.push(what));
  await store.start();
  assert.equal(store.state.costs.summary.total.cost_usd, 1.5);
  assert.equal(store.state.costs.sessions[0].session_id, 's');
  assert.ok(seen.includes('costs'));

  await store.setCostDays(30);
  assert.match(store.state.costs.summary.requested, /days=30/);

  const before = costCalls;
  FakeES.last.fire('event', { id: 90, agent: 'code', type: 'tool_start' }); // no usage: no refetch
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(costCalls, before);
  FakeES.last.fire('event', { id: 91, agent: 'code', type: 'subagent_stop', cost_source: 'computed' });
  FakeES.last.fire('event', { id: 92, agent: 'code', type: 'subagent_stop', usage: {} });
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(costCalls, before + 1, 'bursts are debounced into one refresh');

  fail = true;
  await store.refreshCosts();
  assert.equal(store.state.costs.summary.total.cost_usd, 1.5, 'previous data is kept on error');
  store.stop();
});

test('client store defaults active_steps to [] and keeps it from fetch and SSE', async () => {
  const { createStore } = await import('../public/js/store.js');
  const step = { run_id: 'r', repo: 'example-app', step: 'test', ts: 5, attempt: 1 };
  let body = { run: null, recent_runs: [] };
  const fetchFn = (url) => {
    if (url.startsWith('/api/agents')) return json({ now: Date.now(), agents: [] });
    if (url.startsWith('/api/events')) return json({ events: [], next_before: null });
    return json(body);
  };
  const store = createStore({ fetchFn, EventSourceCtor: FakeES });
  assert.deepEqual(store.state.pipeline.active_steps, []);
  await store.start();
  assert.deepEqual(store.state.pipeline.active_steps, [], 'old server');
  FakeES.last.fire('pipeline', { run: null, recent_runs: [], active_steps: [step] });
  assert.deepEqual(store.state.pipeline.active_steps, [step]);
  FakeES.last.fire('pipeline', { run: null, recent_runs: [], active_steps: 'junk' });
  assert.deepEqual(store.state.pipeline.active_steps, []);
  body = { run: null, recent_runs: [], active_steps: [step] };
  await store.resync();
  assert.deepEqual(store.state.pipeline.active_steps, [step]);
  store.stop();
});
