'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, ev, post, authed, openSse, INGEST, DASH } = require('./helpers');

test('GET /healthz is unauthenticated and returns only ok', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const r = await fetch(`${s.base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('ingest auth: 401 on missing or wrong token, 201 on right one', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  assert.equal((await post(s.base, ev(), null)).status, 401);
  assert.equal((await post(s.base, ev(), 'wrong-wrong-wrong-wrong-wrong')).status, 401);
  assert.equal((await post(s.base, ev(), DASH)).status, 401, 'dashboard token must not ingest');
  const ok = await post(s.base, ev());
  assert.equal(ok.status, 201);
  assert.ok((await ok.json()).id > 0);
});

test('ingest: validation 400, bad JSON 400, body cap 413', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  assert.equal((await post(s.base, ev({ type: 'nope' }))).status, 400);
  assert.equal((await post(s.base, '{not json')).status, 400);
  const big = await post(s.base, ev({ summary: 'x'.repeat(70 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${s.base}/event`, { method: 'GET' })).status, 405);
});

test('ingest is fast and stores redacted/truncated data without raw tool payloads', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const started = process.hrtime.bigint();
  const r = await post(
    s.base,
    ev({
      summary: 'Bash: curl -H "Authorization: Bearer abcdefghijklmnop123456" ' + 'y'.repeat(400),
      tool_input: { command: 'cat /etc/shadow' },
      tool_response: 'SECRET FILE CONTENT',
      meta: { password: 'hunter2', note: 'ok' },
    }),
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.status, 201);
  assert.ok(ms < 250, `ingest took ${ms}ms`);
  const row = s.store.raw.prepare('SELECT * FROM events').get();
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes('abcdefghijklmnop123456'));
  assert.ok(!dump.includes('hunter2'));
  assert.ok(!dump.includes('SECRET FILE CONTENT'));
  assert.ok(!dump.includes('/etc/shadow'));
  assert.ok(row.summary.length <= 200);
});

test('read APIs and UI require dashboard auth; ingest token cannot read', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  for (const p of ['/api/agents', '/api/events', '/api/pipeline', '/api/stream']) {
    assert.equal((await fetch(s.base + p)).status, 401, p);
    assert.equal((await fetch(s.base + p, authed(INGEST))).status, 401, p + ' with ingest token');
  }
  for (const p of ['/api/agents', '/api/events', '/api/pipeline']) {
    assert.equal((await fetch(s.base + p, authed(DASH))).status, 200, p + ' with dashboard token');
  }
  const ui = await fetch(`${s.base}/`, { redirect: 'manual' });
  assert.equal(ui.status, 302);
  assert.equal(ui.headers.get('location'), '/login');
  assert.equal((await fetch(`${s.base}/js/main.js`, { redirect: 'manual' })).status, 302);
});

test('login: wrong token 401, right token sets httpOnly SameSite cookie that grants access', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const bad = await fetch(`${s.base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'token=nope',
  });
  assert.equal(bad.status, 401);
  const good = await fetch(`${s.base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'token=' + encodeURIComponent(DASH),
  });
  assert.equal(good.status, 303);
  const cookie = good.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const api = await fetch(`${s.base}/api/agents`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(api.status, 200);
  const page = await fetch(`${s.base}/`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mission Control/);
});

test('login brute-force throttle returns 429 after repeated failures', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const attempt = () =>
    fetch(`${s.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=bad',
    });
  for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('security headers present, no CORS wildcard', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const r = await fetch(`${s.base}/api/agents`, {
    headers: { Authorization: `Bearer ${DASH}`, Origin: 'http://evil.example' },
  });
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('GET /api/agents lists configured agents, then derives status from events', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  let body = await (await fetch(`${s.base}/api/agents`, h)).json();
  assert.deepEqual(
    body.agents.map((a) => a.id),
    [...s.config.agents, ...s.config.agentNames],
  );
  assert.ok(body.agents.every((a) => a.status === 'idle'));
  await post(s.base, ev({ agent: 'review', task: 'Audit', tokens_in: 10 }));
  await post(s.base, ev({ agent: 'review', type: 'notification', summary: 'needs permission' }));
  body = await (await fetch(`${s.base}/api/agents`, h)).json();
  const sec = body.agents.find((a) => a.id === 'review');
  assert.equal(sec.status, 'blocked');
  assert.equal(sec.current_task, 'Audit');
  assert.equal(sec.tokens.in, 10);
});

const RETIRED = ['test', 'styling', 'security', 'code-review'];

test('retired agent names are accepted and stored but never get a card, a slot or an SSE agent event', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await sse.waitFor((m) => m.event === 'pipeline');
  for (const agent of ['test', 'styling', 'security', 'code-review']) {
    const r = await post(s.base, ev({ agent, summary: `retired-${agent}` }));
    assert.equal(r.status, 201);
  }
  await post(s.base, ev({ agent: 'verify', summary: 'marker' }));
  await sse.waitFor((m) => m.event === 'agent' && m.data.id === 'verify');
  assert.ok(!sse.messages.some((m) => m.event === 'agent' && RETIRED.includes(m.data.id)));
  const body = await (await fetch(`${s.base}/api/agents`, h)).json();
  assert.ok(!body.agents.some((a) => RETIRED.includes(a.id)));
  const evs = await (await fetch(`${s.base}/api/events?limit=50`, h)).json();
  assert.equal(evs.events.filter((e) => String(e.summary).startsWith('retired-')).length, 4);
});

test('unknown events are accepted and stored but never get a card or an SSE agent event', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await sse.waitFor((m) => m.event === 'pipeline');
  const r = await post(s.base, ev({ agent: 'unknown', summary: 'unk-1' }));
  assert.equal(r.status, 201);
  await post(s.base, ev({ agent: 'helper', summary: 'marker' }));
  await sse.waitFor((m) => m.event === 'agent' && m.data.id === 'helper');
  assert.ok(!sse.messages.some((m) => m.event === 'agent' && m.data.id === 'unknown'));
  const body = await (await fetch(`${s.base}/api/agents`, h)).json();
  assert.ok(!body.agents.some((a) => a.id === 'unknown'));
  assert.ok(body.agents.some((a) => a.id === 'helper'));
  const evs = await (await fetch(`${s.base}/api/events?limit=50`, h)).json();
  assert.equal(evs.events.filter((e) => e.agent === 'unknown' && e.summary === 'unk-1').length, 1);
});

test('GET /api/events paginates with before cursor and filters by agent', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  for (let i = 0; i < 7; i++) await post(s.base, ev({ agent: i % 2 ? 'verify' : 'code', summary: `e${i}` }));
  const p1 = await (await fetch(`${s.base}/api/events?limit=3`, h)).json();
  assert.deepEqual(
    p1.events.map((e) => e.summary),
    ['e6', 'e5', 'e4'],
  );
  assert.ok(p1.next_before);
  const p2 = await (await fetch(`${s.base}/api/events?limit=3&before=${p1.next_before}`, h)).json();
  assert.deepEqual(
    p2.events.map((e) => e.summary),
    ['e3', 'e2', 'e1'],
  );
  const f = await (await fetch(`${s.base}/api/events?agent=verify&limit=50`, h)).json();
  assert.deepEqual(
    f.events.map((e) => e.summary),
    ['e5', 'e3', 'e1'],
  );
  assert.equal(f.next_before, null);
  assert.equal((await fetch(`${s.base}/api/events?before=abc`, h)).status, 400);
  const capped = await (await fetch(`${s.base}/api/events?limit=99999`, h)).json();
  assert.equal(capped.events.length, 7);
});

test('GET /api/pipeline reflects pipeline events', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  assert.equal((await (await fetch(`${s.base}/api/pipeline`, h)).json()).run, null);
  await post(
    s.base,
    ev({
      agent: 'orchestrator',
      type: 'pipeline',
      meta: { run_id: 'r', step: 'user-approval', state: 'active', attempt: 2 },
    }),
  );
  const p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.run.status, 'waiting_approval');
  assert.equal(p.run.attempt, 2);
  assert.ok(Array.isArray(p.runs));
  assert.deepEqual(
    p.runs.map((r) => r.run_id),
    ['r'],
  );
  assert.equal(p.runs[0].status, 'waiting_approval');
});

test('activity runs are ingested, redacted, exposed by /api/pipeline and pushed over SSE', async (t) => {
  const s = await startApp({ agents: [] });
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  const mk = (state, summary) =>
    ev({
      agent: 'orchestrator',
      type: 'pipeline',
      summary,
      meta: { run_id: 'srv-1', kind: 'server_task', state, target: 'app-server password=hunter2' },
    });
  assert.equal((await post(s.base, mk('active', 'Restart nginx'))).status, 201);
  assert.equal(
    (await post(s.base, mk('failed', 'failed ' + 'z '.repeat(150) + 'TOKEN=abc123def456'))).status,
    201,
  );
  const p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.run, null);
  assert.equal(p.activity_runs.length, 1);
  const a = p.activity_runs[0];
  assert.equal(a.kind, 'server_task');
  assert.equal(a.state, 'failed');
  assert.ok(a.target.startsWith('app-server'));
  assert.ok(!JSON.stringify(a).includes('hunter2'));
  assert.ok(!JSON.stringify(a).includes('abc123def456'));
  assert.ok(a.summary.length > 200 && a.summary.length <= 400);
  const m = await sse.waitFor(
    (x) => x.event === 'pipeline' && x.data.activity_runs && x.data.activity_runs[0]?.state === 'failed',
  );
  assert.equal(m.data.run, null);
  // no agent card is created for pipeline events
  const agents = await (await fetch(`${s.base}/api/agents`, h)).json();
  assert.ok(!agents.agents.some((x) => x.id === 'orchestrator'));
});

test('active_steps is exposed by /api/pipeline and SSE with id fields only and no token material', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  const mk = (run_id, step, state, summary) =>
    ev({
      agent: 'orchestrator',
      type: 'pipeline',
      summary,
      meta: { run_id, step, state, repo: 'example-app', attempt: 1 },
    });
  await post(s.base, mk('r1', 'test', 'active', 'running npm test TOKEN=abc123def456ghi'));
  await post(s.base, mk('r2', 'security', 'active'));
  const p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.deepEqual(p.active_steps.map((x) => x.step).sort(), ['review', 'verify']);
  assert.deepEqual(p.active_steps.map((x) => x.substep).sort(), ['security', 'test']);
  for (const a of p.active_steps)
    assert.deepEqual(Object.keys(a).sort(), ['attempt', 'repo', 'run_id', 'step', 'substep', 'ts']);
  assert.ok(!JSON.stringify(p.active_steps).includes('abc123def456'));
  assert.ok(!JSON.stringify(p.active_steps).includes(INGEST));
  const m = await sse.waitFor((x) => x.event === 'pipeline' && x.data.active_steps?.length === 2);
  assert.ok(!JSON.stringify(m.data.active_steps).includes('abc123def456'));
  await post(s.base, mk('r1', 'test', 'passed'));
  await sse.waitFor((x) => x.event === 'pipeline' && x.data.active_steps?.length === 1);
});

test('pipeline substep: exposed in steps[].substeps; a bad substep is accepted but dropped', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const mk = (step, substep, state) =>
    ev({
      agent: 'orchestrator',
      type: 'pipeline',
      meta: { run_id: 'r9', step, substep, state, repo: 'example-app' },
    });
  assert.equal((await post(s.base, mk('code', { x: 1 }, 'active'))).status, 201);
  assert.equal((await post(s.base, mk('verify', 'test', 'active'))).status, 201);
  assert.equal((await post(s.base, mk('verify', 'bogus', 'passed'))).status, 201);
  const p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  const names = p.run.steps.map((x) => x.name);
  assert.deepEqual(names, [
    'spec',
    'code',
    'verify',
    'review',
    'user-approval',
    'merge',
    'deploy',
    'cleanup',
  ]);
  const verify = p.run.steps.find((x) => x.name === 'verify');
  assert.deepEqual(
    verify.substeps.map((x) => [x.name, x.state]),
    [
      ['test', 'active'],
      ['styling', 'skipped'],
    ],
  );
  assert.equal(verify.state, 'passed', 'the bad substep was dropped, so the parent-level passed applied');
  assert.deepEqual(p.run.steps.find((x) => x.name === 'code').substeps, []);
});

test('SSE pushes new events and agent-state changes, with heartbeat-capable headers', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  assert.equal(sse.status, 200);
  assert.match(sse.headers['content-type'], /text\/event-stream/);
  await sse.waitFor((m) => m.event === 'pipeline');
  await post(s.base, ev({ agent: 'verify', summary: 'live!' }));
  const msg = await sse.waitFor((m) => m.event === 'event' && m.data.summary === 'live!');
  assert.ok(msg.id);
  const agent = await sse.waitFor(
    (m) => m.event === 'agent' && m.data.id === 'verify' && m.data.status === 'working',
  );
  assert.equal(agent.data.status, 'working');
  await post(
    s.base,
    ev({ agent: 'orchestrator', type: 'pipeline', meta: { run_id: 'r', step: 'spec', state: 'active' } }),
  );
  await sse.waitFor((m) => m.event === 'pipeline' && m.data.run && m.data.run.run_id === 'r');
});

test('SSE honours Last-Event-ID by replaying missed events', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await post(s.base, ev({ summary: `m${i}` }))).json()).id);
  const sse = await openSse(s.base, { 'Last-Event-ID': String(ids[0]) });
  t.after(() => sse.close());
  await sse.waitFor((m) => m.event === 'pipeline');
  const replayed = sse.messages.filter((m) => m.event === 'event').map((m) => m.data.summary);
  assert.deepEqual(replayed, ['m1', 'm2']);
});

test('SSE broadcasts time-based status transitions (done -> idle)', async (t) => {
  let clock = Date.now();
  const s = await startApp({}, { now: () => clock });
  t.after(() => s.stop());
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await post(s.base, ev({ agent: 'cleanup', type: 'stop', ts: clock }));
  await sse.waitFor((m) => m.event === 'agent' && m.data.id === 'cleanup' && m.data.status === 'done');
  clock += 120000;
  s.app.broadcastAgentChanges();
  await sse.waitFor((m) => m.event === 'agent' && m.data.id === 'cleanup' && m.data.status === 'idle');
});

test('prune removes rows past retention and over the row cap', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const now = Date.now();
  const day = 86400000;
  for (const age of [40, 35, 5, 1, 0]) await post(s.base, ev({ ts: now - age * day, summary: `age${age}` }));
  assert.equal(s.store.prune({ retentionDays: 30, maxRows: 1000, now }), 2);
  assert.equal(s.store.count(), 3);
  assert.equal(s.store.prune({ retentionDays: 30, maxRows: 2, now }), 1);
  assert.deepEqual(
    s.store.listEvents({}).map((e) => e.summary),
    ['age0', 'age1'],
  );
});

test('derived state is rebuilt from stored events on startup', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  await post(s.base, ev({ agent: 'code', task: 'persisted task' }));
  const { createApp } = require('../src/server');
  const again = createApp(s.config, s.store);
  const v = again.agents.snapshot(Date.now()).find((a) => a.id === 'code');
  assert.equal(v.status, 'working');
  assert.equal(v.current_task, 'persisted task');
  await again.close();
});

async function loginCookie(base) {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'token=' + encodeURIComponent(DASH),
  });
  return r.headers.get('set-cookie').split(';')[0];
}

test('bearer guessing is throttled: correct token is refused while blocked', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${s.base}/api/agents`, authed('wrong-wrong-wrong-wrong-wrong'))).status, 401);
  }
  const blocked = await fetch(`${s.base}/api/agents`, authed());
  assert.equal(blocked.status, 429, 'correct bearer must not authenticate while blocked');
});

test('logout closes open SSE streams for that session', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const cookie = await loginCookie(s.base);
  const sse = await openSse(s.base, { Authorization: null, Cookie: cookie });
  assert.equal(sse.status, 200);
  const out = await fetch(`${s.base}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
  });
  assert.equal(out.status, 303);
  await Promise.race([
    sse.ended,
    new Promise((_, no) => setTimeout(() => no(new Error('stream not closed')), 2000)),
  ]);
  assert.equal(s.app.clients.size, 0);
});

test('ingest caps distinct agents (422) and in-memory pipeline runs', async (t) => {
  const s = await startApp({ maxAgents: 10, maxRuns: 3, agents: [], agentNames: [] });
  t.after(() => s.stop());
  for (let i = 0; i < 10; i++) assert.equal((await post(s.base, ev({ agent: `a${i}` }))).status, 201);
  assert.equal((await post(s.base, ev({ agent: 'one-too-many' }))).status, 422);
  assert.equal((await post(s.base, ev({ agent: 'a0' }))).status, 201, 'known agents still accepted');
  for (let i = 0; i < 6; i++) {
    const r = await post(
      s.base,
      ev({
        type: 'pipeline',
        agent: 'orchestrator',
        ts: Date.now() + i,
        meta: { run_id: `r${i}`, step: 'spec', state: 'active' },
      }),
    );
    assert.equal(r.status, 201);
  }
  assert.equal(s.app.pipeline.runs.size, 3);
  assert.ok(s.app.pipeline.runs.has('r5'));
});

test('successful ingest is rate limited per IP', async (t) => {
  const s = await startApp({ ingestRatePerMin: 3 });
  t.after(() => s.stop());
  for (let i = 0; i < 3; i++) assert.equal((await post(s.base, ev())).status, 201);
  assert.equal((await post(s.base, ev())).status, 429);
});

test('secure cookie + HSTS by default; opt-out works for plain-HTTP LAN', async (t) => {
  const s = await startApp();
  const s2 = await startApp({ cookieSecure: false });
  t.after(() => Promise.all([s.stop(), s2.stop()]));
  const form = {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'token=' + encodeURIComponent(DASH),
  };
  const a = await fetch(`${s.base}/login`, form);
  assert.match(a.headers.get('set-cookie'), /; Secure/);
  assert.ok(a.headers.get('strict-transport-security'));
  const b = await fetch(`${s2.base}/login`, form);
  assert.doesNotMatch(b.headers.get('set-cookie'), /Secure/);
  assert.equal(b.headers.get('strict-transport-security'), null);
  const api = await fetch(`${s2.base}/api/agents`, {
    headers: { Cookie: b.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(api.status, 200);
});

test('bearer SSE client with a stale/garbage session cookie is not session-bound', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const sse = await openSse(s.base, { Cookie: 'agent_dash_session=garbage-stale-value' });
  assert.equal(sse.status, 200);
  assert.equal(s.app.clients.size, 1);
  for (const c of s.app.clients) assert.equal(s.app.clientSession.get(c), null);
  // A genuine cookie session is still bound (so logout/expiry can close it).
  const cookie = await loginCookie(s.base);
  await openSse(s.base, { Authorization: null, Cookie: cookie });
  const bound = [...s.app.clients].filter((c) => s.app.clientSession.get(c));
  assert.equal(bound.length, 1);
});

// ------------------------------------------------------------ versioned static assets
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeAssetVersion } = require('../src/assets');

test('computeAssetVersion: deterministic, content- and path-sensitive, never throws', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assetver-'));
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), c);
    }
    return d;
  };
  const a = mk({ 'a.js': '1', 'sub/b.css': '2' });
  const b = mk({ 'sub/b.css': '2', 'a.js': '1' });
  const c = mk({ 'a.js': '1', 'sub/b.css': '3' });
  const d = mk({ 'a.js': '1', 'sub/c.css': '2' });
  try {
    const v = computeAssetVersion(a);
    assert.match(v, /^[0-9a-f]{12}$/);
    assert.equal(computeAssetVersion(b), v);
    assert.notEqual(computeAssetVersion(c), v);
    assert.notEqual(computeAssetVersion(d), v);
    assert.match(computeAssetVersion(path.join(a, 'missing')), /^[0-9a-f]{12}$/);
  } finally {
    for (const x of [a, b, c, d]) fs.rmSync(x, { recursive: true, force: true });
  }
});

test('assets: version is stable across app instances and index references it', async (t) => {
  const s1 = await startApp();
  const s2 = await startApp();
  t.after(() => Promise.all([s1.stop(), s2.stop()]));
  const v = s1.app.assetVersion;
  assert.match(v, /^[0-9a-f]{12}$/);
  assert.equal(s2.app.assetVersion, v);

  const r = await fetch(`${s1.base}/`, authed());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(r.headers.get('set-cookie'), null);
  const html = await r.text();
  assert.ok(html.includes(`/v/${v}/js/main.js`));
  assert.ok(html.includes(`/v/${v}/css/app.css`));
  assert.ok(!html.includes('"/js/main.js"') && !html.includes('"/css/app.css"'));
});

test('assets: versioned file is immutable with ETag and 304 on revalidation', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const url = `${s.base}/v/${s.app.assetVersion}/js/main.js`;
  const r = await fetch(url, authed());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(r.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('content-security-policy'));
  assert.equal(r.headers.get('set-cookie'), null);
  const etag = r.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  await r.text();
  const h = { headers: { Authorization: `Bearer ${DASH}`, 'If-None-Match': etag } };
  const r304 = await fetch(url, h);
  assert.equal(r304.status, 304);
  assert.ok(r304.headers.get('content-security-policy'));
  assert.equal(r304.headers.get('etag'), etag);
  const head = await fetch(url, { ...authed(), method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('assets: wrong version and traversal attempts are 404', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const v = s.app.assetVersion;
  const get = (p) => fetch(`${s.base}${p}`, authed());
  const r = await get('/v/000000000000/js/main.js');
  assert.equal(r.status, 404);
  assert.ok(r.headers.get('content-security-policy'));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('cdn-cache-control'), 'no-store');
  for (const p of [
    `/v/${v}/../src/server.js`,
    `/v/${v}/%2e%2e/src/server.js`,
    `/v/${v}/..%2fsrc/server.js`,
    `/v/${v}/js%2f..%2f..%2fsrc/server.js`,
    `/v/${v}/js/main.js%00`,
    `/v/${v}/%00`,
    `/v/${v}/js/..\\..\\src\\server.js`,
    `/v/${v}/nope.js`,
    `/v/${v}/`,
    `/v/${v}`,
  ]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('assets: versioned js/img need auth, versioned css and login page do not', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const v = s.app.assetVersion;
  for (const p of [`/v/${v}/js/main.js`, `/v/${v}/office/atlas.png`, `/v/000000000000/css/app.css`]) {
    const r = await fetch(`${s.base}${p}`, { redirect: 'manual' });
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/login');
  }
  const css = await fetch(`${s.base}/v/${v}/css/app.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(css.headers.get('cdn-cache-control'), 'no-store');
  const login = await fetch(`${s.base}/login`);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.ok((await login.text()).includes(`href="/v/${v}/css/app.css"`));
});

test('assets: legacy unversioned paths still work with revalidation headers', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const r = await fetch(`${s.base}/js/main.js`, authed());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  assert.equal(r.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  await r.text();
  const r304 = await fetch(`${s.base}/js/main.js`, {
    headers: { Authorization: `Bearer ${DASH}`, 'If-None-Match': etag },
  });
  assert.equal(r304.status, 304);
  const css = await fetch(`${s.base}/css/app.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await fetch(`${s.base}/office/atlas.png`, authed())).status, 200);
  assert.equal((await fetch(`${s.base}/office/%2e%2e/src/server.js`, authed())).status, 404);
});

test('assets: the office atlas and layout are served with the right types and security headers', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const v = s.app.assetVersion;
  const png = await fetch(`${s.base}/v/${v}/office/atlas.png`, authed());
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(png.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(png.headers.get('x-frame-options'), 'DENY');
  assert.equal(png.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(png.headers.get('content-security-policy'), /img-src 'self' data:/);
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const layout = await fetch(`${s.base}/v/${v}/office/layout.json`, authed());
  assert.equal(layout.status, 200);
  assert.match(layout.headers.get('content-type'), /^application\/json/);
  assert.equal((await layout.json()).version, 1);
  const atlas = await fetch(`${s.base}/v/${v}/office/atlas.json`, authed());
  assert.equal(atlas.status, 200);
  assert.match(atlas.headers.get('content-type'), /^application\/json/);
  assert.equal(atlas.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(atlas.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(atlas.headers.get('x-frame-options'), 'DENY');
  assert.equal(atlas.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal((await atlas.json()).version, 2);
  assert.equal((await fetch(`${s.base}/v/${v}/office/${['tiles', 'png'].join('.')}`, authed())).status, 404);
});

// ---- GET /api/office-layout (optional layout override) ----
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const scratch = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-layout-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  // The smallest layout-shaped object the server's cheap check accepts, plus extra keys.
  const miniLayout = (extra = {}) => ({
    version: 1,
    tileSize: 16,
    width: 2,
    height: 1,
    layers: { floor: ['..'], walls: ['..'], decor: ['..'] },
    zones: [],
    props: [],
    spots: [],
    ...extra,
  });
  const SECURITY = [
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
  ];

  test('office-layout: unset env is a 404 and needs auth', async (t) => {
    const s = await startApp();
    t.after(() => s.stop());
    assert.equal((await fetch(`${s.base}/api/office-layout`)).status, 401);
    const r = await fetch(`${s.base}/api/office-layout`, authed());
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not found' });
  });

  test('office-layout: a valid file is served fresh on every request with no-store and security headers', async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(miniLayout({ marker: 'one' })));
    const s = await startApp({ officeLayoutPath: file });
    t.after(() => s.stop());
    const r = await fetch(`${s.base}/api/office-layout`, authed());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    for (const h of SECURITY) assert.ok(r.headers.get(h), h);
    assert.deepEqual(await r.json(), miniLayout({ marker: 'one' }));
    fs.writeFileSync(file, JSON.stringify(miniLayout({ marker: 'two' })));
    assert.equal((await (await fetch(`${s.base}/api/office-layout`, authed())).json()).marker, 'two');
    const head = await fetch(`${s.base}/api/office-layout`, { ...authed(), method: 'HEAD' });
    assert.equal(head.status, 200);
  });

  test('office-layout: missing file, directory and bad env values are 404 without echoing the path', async (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify(miniLayout()));
    fs.symlinkSync(dir, path.join(dir, 'dirlink'));
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'filelink.json'));
    fs.symlinkSync(path.join(dir, 'gone.json'), path.join(dir, 'dangling.json'));
    const cases = [
      path.join(dir, 'missing.json'),
      dir,
      path.join(dir, 'dirlink'),
      path.join(dir, 'dangling.json'),
      path.join(dir, 'sub', '..', '..', 'etc', 'passwd-nope'),
      '../../../../etc/shadow-nope',
      '/dev/null',
      `${path.join(dir, 'real.json')}\0.json`,
    ];
    for (const officeLayoutPath of cases) {
      const s = await startApp({ officeLayoutPath });
      const r = await fetch(`${s.base}/api/office-layout`, authed());
      const body = await r.text();
      await s.stop();
      assert.equal(r.status, 404, JSON.stringify(officeLayoutPath));
      assert.equal(body, JSON.stringify({ error: 'not found' }));
    }
    // a symlink to a regular file is the operator's choice and is followed
    const s = await startApp({ officeLayoutPath: path.join(dir, 'filelink.json') });
    t.after(() => s.stop());
    assert.equal((await fetch(`${s.base}/api/office-layout`, authed())).status, 200);
  });

  test('office-layout: 413 above 512 KiB (exactly 512 KiB is fine), 422 for bad JSON or a non-object', async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'layout.json');
    const s = await startApp({ officeLayoutPath: file });
    t.after(() => s.stop());
    const get = () => fetch(`${s.base}/api/office-layout`, authed());

    const base = JSON.stringify(miniLayout({ pad: '' })).length;
    const pad = (n) => JSON.stringify(miniLayout({ pad: 'x'.repeat(n - base) }));
    fs.writeFileSync(file, pad(512 * 1024));
    assert.equal(fs.statSync(file).size, 512 * 1024);
    assert.equal((await get()).status, 200);
    fs.writeFileSync(file, pad(512 * 1024 + 1));
    const big = await get();
    assert.equal(big.status, 413);
    assert.equal(big.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await big.json(), { error: 'layout too large' });

    for (const content of ['{not json', '', '[1,2]', '"str"', '42', 'null', 'true']) {
      fs.writeFileSync(file, content);
      const r = await get();
      assert.equal(r.status, 422, JSON.stringify(content));
      const text = await r.text();
      assert.equal(text, JSON.stringify({ error: 'invalid json' }));
      assert.ok(!text.includes(dir) && !text.includes('Unexpected'));
    }
  });

  test('office-layout: the bundled layout and a minimal layout are served unchanged (GET and HEAD)', async (t) => {
    const dir = scratch(t);
    const bundledText = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'office', 'layout.json'),
      'utf8',
    );
    for (const content of [bundledText, JSON.stringify(miniLayout())]) {
      const file = path.join(dir, 'layout.json');
      fs.writeFileSync(file, content);
      const s = await startApp({ officeLayoutPath: file });
      const r = await fetch(`${s.base}/api/office-layout`, authed());
      const text = await r.text();
      const head = await fetch(`${s.base}/api/office-layout`, { ...authed(), method: 'HEAD' });
      await s.stop();
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      for (const h of SECURITY) assert.ok(r.headers.get(h), h);
      assert.deepEqual(JSON.parse(text), JSON.parse(content));
      assert.equal(head.status, 200);
    }
  });

  test('office-layout: JSON that is not a layout is a 422 that echoes nothing from the file', async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'layout.json');
    const S = 'SENTINEL-9f3a';
    const fixtures = {
      array: [S],
      empty: {},
      packageJson: { name: `${S}-pkg`, version: '1.0.0', dependencies: { [`${S}-dep`]: '1' }, scripts: {} },
      credentials: { [`${S}-token`]: `${S}-secret`, password: `${S}-pw` },
      wrongVersion: miniLayout({ version: 2, marker: S }),
    };
    const s = await startApp({ officeLayoutPath: file });
    t.after(() => s.stop());
    for (const [name, value] of Object.entries(fixtures)) {
      fs.writeFileSync(file, JSON.stringify(value));
      const r = await fetch(`${s.base}/api/office-layout`, authed());
      const text = await r.text();
      assert.equal(r.status, 422, name);
      assert.equal(r.headers.get('cache-control'), 'no-store', name);
      assert.equal(text, '{"error":"invalid json"}', name);
      assert.ok(!text.includes(S) && !text.includes(dir) && !text.includes('layout.json'), name);
    }
  });

  test('office-layout: a layout whose extra key cannot be serialised is a 422 and the server stays up', async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'layout.json');
    const n = 100000;
    const nested = '['.repeat(n) + ']'.repeat(n);
    const text = JSON.stringify(miniLayout({ x: 0 })).replace('"x":0', `"x":${nested}`);
    assert.ok(text.length < 512 * 1024);
    fs.writeFileSync(file, text);
    const s = await startApp({ officeLayoutPath: file });
    t.after(() => s.stop());
    const r = await fetch(`${s.base}/api/office-layout`, authed());
    assert.equal(r.status, 422);
    assert.equal(await r.text(), '{"error":"invalid json"}');
    fs.writeFileSync(file, JSON.stringify(miniLayout()));
    assert.equal((await fetch(`${s.base}/api/office-layout`, authed())).status, 200);
  });

  test('office-layout: a FIFO is a 404 and does not hang', async (t) => {
    const dir = scratch(t);
    const fifo = path.join(dir, 'pipe');
    try {
      require('node:child_process').execFileSync('mkfifo', [fifo], { stdio: 'ignore' });
    } catch {
      t.skip('mkfifo unavailable');
      return;
    }
    const s = await startApp({ officeLayoutPath: fifo });
    t.after(() => s.stop());
    const r = await fetch(`${s.base}/api/office-layout`, { ...authed(), signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), '{"error":"not found"}');
  });

  test('office-layout: only GET and HEAD, and the query string has no effect', async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'layout.json');
    fs.writeFileSync(file, JSON.stringify(miniLayout({ marker: 'env' })));
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify(miniLayout({ marker: 'other' })));
    const s = await startApp({ officeLayoutPath: file });
    t.after(() => s.stop());
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${s.base}/api/office-layout`, {
        ...authed(),
        method,
        body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{}' : undefined,
      });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'GET, HEAD');
    }
    for (const q of [
      '?path=../..',
      `?path=${encodeURIComponent(path.join(dir, 'other.json'))}`,
      '?file=/etc/passwd',
    ]) {
      const r = await fetch(`${s.base}/api/office-layout${q}`, authed());
      assert.equal(r.status, 200);
      assert.equal((await r.json()).marker, 'env', q);
    }
  });

  test('office-layout: OFFICE_LAYOUT_PATH is read by the config and blank means unset', async () => {
    const { loadConfig } = require('../src/config');
    const base = { INGEST_TOKEN: INGEST, DASHBOARD_TOKEN: DASH };
    assert.equal(loadConfig(base).officeLayoutPath, '');
    assert.equal(loadConfig({ ...base, OFFICE_LAYOUT_PATH: '  ' }).officeLayoutPath, '');
    assert.equal(
      loadConfig({ ...base, OFFICE_LAYOUT_PATH: '/data/layout.json' }).officeLayoutPath,
      '/data/layout.json',
    );
  });
}

test('GET /api/pipeline and SSE show skipped substeps under a passed parent', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const pe = (meta) => ev({ agent: 'orchestrator', type: 'pipeline', meta: { run_id: 'sk', ...meta } });
  await post(s.base, pe({ step: 'verify', substep: 'test', state: 'passed' }));
  await post(s.base, pe({ step: 'code', state: 'active', attempt: 2 }));
  await post(s.base, pe({ step: 'review', state: 'passed' }));
  const p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  const review = p.run.steps.find((x) => x.name === 'review');
  assert.equal(review.state, 'passed');
  assert.deepEqual(
    review.substeps.map((x) => x.state),
    ['skipped', 'skipped'],
  );
  assert.deepEqual(p.run.active_steps ?? [], []);
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  const m = await sse.waitFor((x) => x.event === 'pipeline');
  assert.deepEqual(m.data.run.steps.find((x) => x.name === 'review').substeps, review.substeps);
});

// ---- abandoned runs ----
const pev = (ts, meta, extra = {}) =>
  ev({ agent: 'orchestrator', type: 'pipeline', ts, meta: { run_id: 'ab', ...meta }, ...extra });

test('abandoned: /api/pipeline and the SSE connect frame use the server clock; revival', async (t) => {
  let clock = Date.now();
  const s = await startApp({}, { now: () => clock });
  t.after(() => s.stop());
  const h = authed();
  await post(s.base, pev(clock, { step: 'code', state: 'active' }));
  await post(s.base, pev(clock, { run_id: 'q', kind: 'question', state: 'active', target: 'example-app' }));
  let p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.run.status, 'running');
  clock += 61 * 60000;
  p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.run.status, 'abandoned');
  assert.equal(p.activity_runs[0].state, 'abandoned');
  assert.deepEqual(p.active_steps, []);
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  const frame = await sse.waitFor((m) => m.event === 'pipeline');
  assert.equal(frame.data.run.status, 'abandoned');
  const n = s.store.count();
  await post(s.base, pev(clock, { step: 'code', state: 'active' }));
  p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.run.status, 'running');
  assert.equal(p.run.abandoned, undefined);
  assert.equal(s.store.count(), n + 1, 'events are only added, never rewritten');
});

test('abandoned: /api/pipeline runs drops an abandoned run after the window and revival restores it', async (t) => {
  let clock = Date.now();
  const s = await startApp({}, { now: () => clock });
  t.after(() => s.stop());
  const h = authed();
  await post(s.base, pev(clock, { step: 'code', state: 'active' }));
  clock += 90 * 60000;
  let p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.runs.length, 1);
  assert.equal(p.runs[0].status, 'abandoned');
  clock += 31 * 60000;
  p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.deepEqual(p.runs, []);
  assert.equal(p.recent_runs[0].status, 'abandoned');
  await post(s.base, pev(clock, { step: 'code', state: 'active' }));
  p = await (await fetch(`${s.base}/api/pipeline`, h)).json();
  assert.equal(p.runs.length, 1);
  assert.equal(p.runs[0].status, 'running');
});

test('abandoned: a timer push sends the pipeline event with no ingest', async (t) => {
  let clock = Date.now();
  const s = await startApp({}, { now: () => clock });
  t.after(() => s.stop());
  await post(s.base, pev(clock, { step: 'code', state: 'active' }));
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await sse.waitFor((m) => m.event === 'pipeline' && m.data.run.status === 'running');
  s.app.broadcastPipelineChanges(); // sync lastSent with the connect frame state
  const seen = sse.messages.length;
  s.app.broadcastPipelineChanges();
  clock += 61 * 60000;
  s.app.broadcastPipelineChanges();
  const m = await sse.waitFor((x) => x.event === 'pipeline' && x.data.run.status === 'abandoned');
  assert.equal(m.data.run.abandoned, true);
  assert.ok(sse.messages.length > seen);
});

test('abandoned: startup replay of old stored rows comes back abandoned; approval does not', async (t) => {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/server');
  const { makeConfig } = require('./helpers');
  const store = openDb(':memory:');
  const old = Date.now() - 3 * 3600000;
  const ins = (e) => store.insertEvent({ session_id: 's', agent: 'orchestrator', type: 'pipeline', ...e });
  ins({ ts: old, meta: { run_id: 'old-q', kind: 'question', state: 'active', target: 'x' } });
  ins({ ts: old, meta: { run_id: 'old-f', step: 'code', state: 'active' } });
  ins({ ts: old + 1, meta: { run_id: 'old-w', step: 'user-approval', state: 'active' } });
  const before = store.count();
  const app = createApp(makeConfig(), store);
  t.after(async () => {
    await app.close();
    store.close();
  });
  const snap = app.pipeline.snapshot(Date.now());
  assert.equal(snap.activity_runs.find((r) => r.run_id === 'old-q').state, 'abandoned');
  assert.equal(snap.run.run_id, 'old-w');
  assert.equal(snap.run.status, 'waiting_approval');
  assert.equal(snap.recent_runs.find((r) => r.run_id === 'old-f').status, 'abandoned');
  assert.equal(store.count(), before);
});

test('a database created before the instance column opens, migrates and keeps its rows', async (t) => {
  const Database = require('better-sqlite3');
  const { openDb } = require('../src/db');
  const { tempDir } = require('./helpers');
  const file = require('node:path').join(tempDir(t), 'old.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL,
    session_id TEXT NOT NULL, type TEXT NOT NULL, tool TEXT, summary TEXT, task TEXT, repo TEXT,
    branch TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, meta TEXT)`);
  old
    .prepare("INSERT INTO events (ts, agent, session_id, type) VALUES (1000, 'code', 's', 'tool_start')")
    .run();
  old.close();
  const store = openDb(file);
  t.after(() => store.close());
  const rows = store.listEvents({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instance, null);
  const row = store.insertEvent({
    ts: 2000,
    agent: 'code',
    session_id: 's:a1',
    type: 'tool_start',
    instance: 'code:2',
  });
  assert.equal(row.instance, 'code:2');
  assert.deepEqual(
    store.listEvents({ instance: 'code:2' }).map((r) => r.id),
    [row.id],
  );
  assert.equal(store.listEvents({ agent: 'code' }).length, 2, 'the role filter still matches both');
});

test('GET /api/events validates the optional instance filter', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  await post(s.base, ev({ summary: 'x' }));
  const ok = await fetch(`${s.base}/api/events?instance=code:2`, authed());
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).events, []);
  assert.equal((await fetch(`${s.base}/api/events?instance=bad%20one`, authed())).status, 400);
  const all = await (await fetch(`${s.base}/api/events`, authed())).json();
  assert.equal(all.events[0].instance, null);
});

// ---------------------------------------------------------------- named people

const sub = (n, role, over = {}) => ev({ agent: role, session_id: `sess:agent${n}`, ...over });
const getAgents = async (s) => (await (await fetch(`${s.base}/api/agents`, authed())).json()).agents;

test('ingest gives each subagent a person, ignores a client-sent instance and stores it', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  await post(s.base, sub(1, 'spec', { instance: 'Hugo', run_id: 'r1' }));
  await post(s.base, sub(2, 'code'));
  await post(s.base, ev({ agent: 'orchestrator', session_id: 'top', instance: 'Dax' }));
  const rows = s.store.listEvents({}).reverse();
  assert.deepEqual(
    rows.map((r) => r.instance),
    ['Ada', 'Bram', null],
  );
  const agents = await getAgents(s);
  assert.deepEqual(
    agents.map((a) => a.id),
    ['orchestrator', ...s.config.agentNames],
  );
  const ada = agents.find((a) => a.id === 'Ada');
  assert.deepEqual([ada.role, ada.name, ada.status], ['spec', 'Ada', 'working']);
  assert.equal(agents.find((a) => a.id === 'Hugo').status, 'idle', 'the full pool is shown idle');
  const byInstance = await (await fetch(`${s.base}/api/events?instance=Bram`, authed())).json();
  assert.equal(byInstance.events.length, 1);
  const byRole = await (await fetch(`${s.base}/api/events?agent=spec`, authed())).json();
  assert.equal(byRole.events[0].instance, 'Ada');
});

test('a stop rests the person, pushes the view over SSE and the next spawn skips them', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await post(s.base, sub(1, 'spec'));
  await post(s.base, sub(1, 'spec', { type: 'subagent_stop' }));
  const msg = await sse.waitFor(
    (m) => m.event === 'agent' && m.data.id === 'Ada' && m.data.status === 'resting',
  );
  assert.ok(msg.data.cooldown_until > Date.now());
  await post(s.base, sub(2, 'code'));
  const agents = await getAgents(s);
  assert.equal(agents.find((a) => a.id === 'Bram').status, 'working');
  assert.deepEqual(agents.find((a) => a.id === 'Bram').handoff.from, 'Ada');
  assert.equal(agents.find((a) => a.id === 'Ada').handoff.inferred, true);
});

test('a stopped agent that continues returns to its person', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  await post(s.base, sub(1, 'spec'));
  await post(s.base, sub(1, 'spec', { type: 'subagent_stop' }));
  await post(s.base, sub(1, 'spec'));
  assert.deepEqual(
    s.store
      .listEvents({})
      .reverse()
      .map((r) => r.instance),
    ['Ada', 'Ada', 'Ada'],
  );
});

test('restart replay restores people from stored rows without reassigning', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  await post(s.base, sub(1, 'spec'));
  await post(s.base, sub(2, 'code'));
  const { createApp } = require('../src/server');
  const app2 = createApp(s.config, s.store);
  t.after(() => app2.close());
  const ids = app2.agents.snapshot(Date.now()).filter((a) => a.status === 'working');
  assert.deepEqual(
    ids.map((a) => [a.id, a.role]),
    [
      ['Ada', 'spec'],
      ['Bram', 'code'],
    ],
  );
  assert.equal(app2.agents.assign(sub(3, 'review'), Date.now()), 'Carl');
});

test('overflow people are stored as extra-<n>, removed once idle, and clients are told to resync', async (t) => {
  const clock = { t: Date.now() };
  const s = await startApp({ agentNames: ['Ada'] }, { now: () => clock.t });
  t.after(() => s.stop());
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await post(s.base, sub(1, 'spec', { ts: clock.t }));
  await post(s.base, sub(2, 'code', { ts: clock.t }));
  assert.equal(s.store.listEvents({})[0].instance, 'extra-1');
  assert.ok((await getAgents(s)).some((a) => a.id === 'extra-1' && a.label === 'Extra 1'));
  await post(s.base, sub(2, 'code', { type: 'subagent_stop', ts: clock.t }));
  clock.t += 120000;
  s.app.broadcastAgentChanges();
  await sse.waitFor((m) => m.event === 'resync');
  assert.ok(!(await getAgents(s)).some((a) => a.id === 'extra-1'));
});

test('cost totals are identical with and without pooling on the same events', async () => {
  const events = [
    sub(1, 'code', { tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }),
    sub(2, 'code', { tokens_in: 50, tokens_out: 5, cost_usd: 0.25 }),
    sub(1, 'code', { type: 'subagent_stop', tokens_in: 1, cost_usd: 0.01 }),
    sub(3, 'review', { tokens_in: 7, cost_usd: 0.1 }),
  ];
  const totals = async (names) => {
    const s = await startApp({ agentNames: names });
    try {
      for (const e of events) await post(s.base, e);
      const c = await (await fetch(`${s.base}/api/costs?days=1`, authed())).json();
      return { total: c.total, by_agent: c.by_agent };
    } finally {
      await s.stop();
    }
  };
  assert.deepEqual(await totals(['Ada', 'Bram', 'Carl']), await totals([]));
});

test('GET /api/agents exposes display_names and the mapped label; ids stay raw', async (t) => {
  const s = await startApp({ agentDisplayNames: { orchestrator: 'Example Bot' } });
  t.after(() => s.stop());
  const h = { headers: { Authorization: `Bearer ${DASH}` } };
  const sse = await openSse(s.base);
  t.after(() => sse.close());
  await post(s.base, ev({ agent: 'orchestrator', session_id: 'o1', summary: 'hello' }));
  const m = await sse.waitFor((x) => x.event === 'agent' && x.data.id === 'orchestrator');
  assert.equal(m.data.label, 'Example Bot');
  const body = await (await fetch(`${s.base}/api/agents`, h)).json();
  assert.deepEqual(body.display_names, { orchestrator: 'Example Bot' });
  const card = body.agents.find((a) => a.id === 'orchestrator');
  assert.equal(card.label, 'Example Bot');
  assert.equal(card.agent, 'orchestrator');
  const evs = await (await fetch(`${s.base}/api/events?limit=5`, h)).json();
  assert.equal(evs.events[0].agent, 'orchestrator');
});

test('GET /api/agents without a mapping has empty display_names and raw labels', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const body = await (
    await fetch(`${s.base}/api/agents`, { headers: { Authorization: `Bearer ${DASH}` } })
  ).json();
  assert.deepEqual(body.display_names, {});
  assert.equal(body.agents.find((a) => a.id === 'orchestrator').label, 'orchestrator');
});

test('link events: stored and returned by /api/events; a top-level session is rejected and stores nothing', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const link = (over) =>
    ev({
      type: 'link',
      tool: undefined,
      session_id: 'p1:a1',
      meta: { run_id: 'alpha-1000000001-1001' },
      ...over,
    });
  assert.equal((await post(s.base, link({ session_id: 'p1' }))).status, 400);
  assert.equal((await post(s.base, link({ meta: { run_id: 'bad id' } }))).status, 400);
  assert.equal(s.store.raw.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  const r = await post(s.base, link({ instance: 'Zed' }));
  assert.equal(r.status, 201);
  const rows = (await (await fetch(`${s.base}/api/events`, authed(DASH))).json()).events;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'link');
  assert.equal(rows[0].instance, 'Ada', 'the person is assigned at ingest, never taken from the client');
  assert.deepEqual(rows[0].meta, { run_id: 'alpha-1000000001-1001' });
});
