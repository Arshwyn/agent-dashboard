'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/state');
const { AgentTracker, RETIRED_AGENTS, UNTRACKED_AGENTS, PANEL_GRACE_MINUTES, PANEL_ABANDONED_MINUTES } =
  state;

// Older tests read the wall clock via snapshot(); give them an effectively infinite staleness
// threshold unless a test sets staleMinutes itself (the abandoned tests below do).
class PipelineTracker extends state.PipelineTracker {
  constructor(o = {}) {
    super({ staleMinutes: 1e9, ...o });
  }
}

const T0 = Date.UTC(2026, 9, 18, 6, 0, 0);
const e = (over) => ({ ts: T0, agent: 'code', session_id: 's', type: 'tool_start', ...over });
const tracker = () =>
  new AgentTracker({ doneToIdleSeconds: 60, staleMinutes: 10, configured: ['spec', 'code'] });

test('unseen configured agents show as idle; seen extras are appended', () => {
  const t = tracker();
  t.apply(e({ agent: 'brand-new' }));
  const snap = t.snapshot(T0);
  assert.deepEqual(
    snap.map((a) => a.id),
    ['spec', 'code', 'brand-new'],
  );
  assert.equal(snap[0].status, 'idle');
  assert.equal(snap[2].status, 'working');
});

test('retired agents are untracked: no card, no slot, replay creates nothing', () => {
  assert.deepEqual(RETIRED_AGENTS, ['test', 'styling', 'security', 'code-review']);
  const t = new AgentTracker({ configured: ['spec', 'test'], maxAgents: 2 });
  for (const agent of RETIRED_AGENTS) {
    assert.equal(t.canTrack(agent), true);
    assert.equal(t.apply(e({ agent })), null);
  }
  assert.equal(t.agents.size, 0);
  assert.deepEqual(
    t.snapshot(T0).map((a) => a.id),
    ['spec'],
  );
  t.apply(e({ agent: 'code' }));
  t.apply(e({ agent: 'verify' }));
  assert.equal(t.canTrack('review'), false);
  assert.equal(t.canTrack('test'), true);
});

test('unknown is untracked like a retired name; helper still gets a card', () => {
  assert.deepEqual(UNTRACKED_AGENTS, [...RETIRED_AGENTS, 'unknown']);
  const t = new AgentTracker({ configured: ['spec', 'unknown'], maxAgents: 2 });
  assert.equal(t.canTrack('unknown'), true);
  assert.equal(t.apply(e({ agent: 'unknown' })), null);
  assert.equal(t.agents.size, 0);
  t.apply(e({ agent: 'helper' }));
  t.apply(e({ agent: 'unknown' })); // replay order does not matter
  assert.deepEqual(
    t.snapshot(T0).map((a) => a.id),
    ['spec', 'helper'],
  );
  assert.equal(t.canTrack('unknown'), true);
  t.apply(e({ agent: 'code' })); // helper + code fill the two slots; unknown took none
  assert.equal(t.canTrack('review'), false);
  assert.equal(t.canTrack('unknown'), true);
});

test('tool activity -> working; notification -> blocked; stop -> done then idle after timeout', () => {
  const t = tracker();
  t.apply(e({ task: 'Build it' }));
  assert.equal(t.snapshot(T0)[1].status, 'working');
  assert.equal(t.snapshot(T0)[1].current_task, 'Build it');
  t.apply(e({ ts: T0 + 1000, type: 'notification', summary: 'permission' }));
  assert.equal(t.snapshot(T0 + 1000)[1].status, 'blocked');
  t.apply(e({ ts: T0 + 2000, type: 'tool_end' }));
  assert.equal(t.snapshot(T0 + 2000)[1].status, 'working');
  t.apply(e({ ts: T0 + 3000, type: 'subagent_stop' }));
  assert.equal(t.snapshot(T0 + 3000)[1].status, 'done');
  assert.equal(t.snapshot(T0 + 3000 + 59000)[1].status, 'done');
  const idle = t.snapshot(T0 + 3000 + 61000)[1];
  assert.equal(idle.status, 'idle');
  assert.equal(idle.current_task, null);
});

test('stop event also yields done', () => {
  const t = tracker();
  t.apply(e());
  t.apply(e({ ts: T0 + 10, type: 'stop' }));
  assert.equal(t.snapshot(T0 + 10)[1].status, 'done');
});

test('working with no events for N minutes is shown as stale idle', () => {
  const t = tracker();
  t.apply(e());
  assert.equal(t.snapshot(T0 + 9 * 60000)[1].status, 'working');
  const v = t.snapshot(T0 + 11 * 60000)[1];
  assert.equal(v.status, 'idle');
  assert.equal(v.stale, true);
});

test('token and cost totals accumulate per run and reset on a new run; today persists', () => {
  const t = tracker();
  t.apply(e({ tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }));
  t.apply(e({ ts: T0 + 1000, type: 'tool_end', tokens_in: 50, tokens_out: 5, cost_usd: 0.25 }));
  t.apply(e({ ts: T0 + 2000, type: 'stop' }));
  let v = t.snapshot(T0 + 2000)[1];
  assert.deepEqual(v.tokens, { in: 150, out: 15 });
  assert.equal(v.cost_usd, 0.75);
  // a later run (after done -> idle) resets run totals
  t.apply(e({ ts: T0 + 120000, tokens_in: 7, tokens_out: 1 }));
  v = t.snapshot(T0 + 120000)[1];
  assert.deepEqual(v.tokens, { in: 7, out: 1 });
  assert.deepEqual(v.today.tokens, { in: 157, out: 16 });
  assert.equal(v.run_started_ts, T0 + 120000);
});

test('explicit status events can set the state; pipeline events do not touch agents', () => {
  const t = tracker();
  t.apply(e({ type: 'status', meta: { state: 'blocked' } }));
  assert.equal(t.snapshot(T0)[1].status, 'blocked');
  assert.equal(t.apply(e({ agent: 'orchestrator', type: 'pipeline' })), null);
  assert.ok(!t.snapshot(T0).some((a) => a.id === 'orchestrator'));
});

const pe = (ts, meta, summary) => ({
  ts: T0 + ts,
  agent: 'orchestrator',
  session_id: 'o',
  type: 'pipeline',
  summary,
  meta: { run_id: 'r1', ...meta },
});

test('pipeline: steps progress, approval wait, retry counter, failed gate and failure summary', () => {
  const p = new PipelineTracker({ maxAttempts: 3 });
  assert.equal(p.snapshot().run, null);
  p.apply(pe(0, { step: 'spec', state: 'passed', repo: 'x' }));
  p.apply(pe(1, { step: 'code', state: 'passed', attempt: 1, pr_url: 'https://gh/pr/1' }));
  p.apply(pe(2, { step: 'test', state: 'failed', attempt: 1, failed_gate: 'test' }, 'npm test: 2 failing'));
  let r = p.snapshot().run;
  assert.equal(r.attempt, 1);
  assert.equal(r.failed_gate, 'test');
  assert.equal(r.last_failure, 'npm test: 2 failing');
  assert.equal(r.steps.find((s) => s.name === 'verify').state, 'failed');
  assert.equal(r.status, 'running');

  // retry: code restarts, later steps reset, counter bumps, failure info retained
  p.apply(pe(3, { step: 'code', state: 'active', attempt: 2 }));
  r = p.snapshot().run;
  assert.equal(r.attempt, 2);
  assert.equal(r.steps.find((s) => s.name === 'verify').state, 'pending');
  assert.equal(r.failed_gate, 'test');

  for (const g of ['code', 'test', 'security', 'styling', 'code-review'])
    p.apply(pe(4, { step: g, state: 'passed', attempt: 2 }));
  p.apply(pe(5, { step: 'user-approval', state: 'active' }));
  r = p.snapshot().run;
  assert.equal(r.waiting_on_user_approval, true);
  assert.equal(r.status, 'waiting_approval');
  assert.equal(r.max_attempts, 3);
});

test('pipeline: third failed attempt is terminal; deploy results are tracked', () => {
  const p = new PipelineTracker({ maxAttempts: 3 });
  p.apply(pe(0, { step: 'security', state: 'failed', attempt: 3 }, 'finding: high'));
  assert.equal(p.snapshot().run.status, 'failed');

  const q = new PipelineTracker({ maxAttempts: 3 });
  q.apply(pe(0, { step: 'deploy', state: 'active' }));
  q.apply(pe(1, { step: 'deploy', deploy_result: 'failure+rolled_back' }));
  let r = q.snapshot().run;
  assert.equal(r.deploy_result, 'failure_rolled_back');
  assert.equal(r.steps.find((s) => s.name === 'deploy').state, 'failed');
  q.apply(pe(2, { step: 'deploy', state: 'active' }));
  q.apply(pe(3, { step: 'deploy', deploy_result: 'success' }));
  q.apply(pe(4, { step: 'cleanup', state: 'passed' }));
  r = q.snapshot().run;
  assert.equal(r.deploy_result, 'success');
  assert.equal(r.status, 'complete');
});

test('pipeline: latest run is current and recent runs listed', () => {
  const p = new PipelineTracker();
  p.apply({
    ...pe(0, { step: 'spec', state: 'active' }),
    meta: { run_id: 'a', step: 'spec', state: 'active' },
  });
  p.apply({
    ...pe(5, { step: 'spec', state: 'active' }),
    meta: { run_id: 'b', step: 'spec', state: 'active' },
  });
  const s = p.snapshot();
  assert.equal(s.run.run_id, 'b');
  assert.equal(s.recent_runs.length, 2);
});

test('pipeline: deploy result survives later steps but resets when an earlier step restarts', () => {
  const p = new PipelineTracker();
  p.apply(pe(0, { step: 'deploy', deploy_result: 'success' }));
  p.apply(pe(1, { step: 'cleanup', state: 'active' }));
  assert.equal(p.snapshot().run.deploy_result, 'success');
  p.apply(pe(2, { step: 'code', state: 'active' }));
  assert.equal(p.snapshot().run.deploy_result, null);
});

const ae = (ts, run_id, kind, state, extra = {}, summary) => ({
  ts: T0 + ts,
  agent: 'orchestrator',
  session_id: 'o',
  type: 'pipeline',
  summary,
  meta: { run_id, kind, state, ...extra },
});

test('activity: question goes active -> passed with start and end', () => {
  const p = new PipelineTracker();
  p.apply(ae(0, 'q1', 'question', 'active', { target: 'example-app' }, 'How does auth work?'));
  let a = p.snapshot().activity_runs[0];
  assert.deepEqual(
    [a.kind, a.target, a.summary, a.state, a.started_ts, a.ended_ts],
    ['question', 'example-app', 'How does auth work?', 'active', T0, null],
  );
  p.apply(ae(5000, 'q1', 'question', 'passed', {}, 'Answered'));
  a = p.snapshot().activity_runs[0];
  assert.equal(a.state, 'passed');
  assert.equal(a.ended_ts, T0 + 5000);
  assert.equal(a.started_ts, T0);
  assert.equal(a.summary, 'Answered');
  assert.equal(p.snapshot().activity_runs.length, 1);
});

test('activity: server_task failed keeps target and summary; target falls back to repo', () => {
  const p = new PipelineTracker();
  p.apply(ae(0, 's1', 'server_task', 'active', { target: 'app-server' }, 'Restart nginx'));
  p.apply(ae(1000, 's1', 'server_task', 'failed', { target: 'app-server' }, 'nginx would not start'));
  const a = p.snapshot().activity_runs[0];
  assert.equal(a.state, 'failed');
  assert.equal(a.target, 'app-server');
  assert.equal(a.summary, 'nginx would not start');
  p.apply({ ...ae(2000, 's2', 'question', 'active'), repo: 'example-app' });
  assert.equal(p.snapshot().activity_runs[0].target, 'example-app');
});

test('activity: single_role carries a valid role only', () => {
  const p = new PipelineTracker();
  p.apply(ae(0, 'a', 'single_role', 'active', { step: 'test', target: 'example-app' }));
  p.apply(ae(1, 'b', 'single_role', 'active', { step: 'bogus' }));
  p.apply(ae(2, 'c', 'question', 'active', { step: 'test' }));
  const by = Object.fromEntries(p.snapshot().activity_runs.map((r) => [r.run_id, r]));
  assert.equal(by.a.role, 'test');
  assert.equal(by.b.role, null);
  assert.equal(by.c.role, null);
});

test('activity: missing or unknown kind is a feature run', () => {
  const p = new PipelineTracker();
  p.apply(pe(0, { step: 'spec', state: 'active' }));
  p.apply({
    ...pe(1, { step: 'code', state: 'active' }),
    meta: { run_id: 'x', kind: 'weird', step: 'code', state: 'active' },
  });
  const s = p.snapshot();
  assert.equal(s.activity_runs.length, 0);
  assert.equal(s.run.run_id, 'x');
  assert.equal(s.run.kind, 'feature');
  assert.equal(s.run.steps.find((st) => st.name === 'code').state, 'active');
});

test('activity: non-feature runs never change the feature run or the stepper', () => {
  const p = new PipelineTracker();
  p.apply(pe(0, { step: 'spec', state: 'passed' }));
  const before = JSON.stringify(p.snapshot().run);
  p.apply(ae(10, 'q', 'question', 'active', {}, 'hi'));
  p.apply(ae(11, 'q', 'question', 'passed', { step: 'deploy' }));
  p.apply(ae(12, 'sr', 'single_role', 'failed', { step: 'code' }));
  const s = p.snapshot();
  assert.equal(JSON.stringify(s.run), before);
  assert.equal(s.run.run_id, 'r1');
  assert.equal(s.activity_runs.length, 2);
  assert.deepEqual(
    s.recent_runs.map((r) => [r.run_id, r.kind, r.status]),
    [
      ['sr', 'single_role', 'failed'],
      ['q', 'question', 'passed'],
      ['r1', 'feature', 'running'],
    ],
  );
  // no feature run at all: run stays null
  const q = new PipelineTracker();
  q.apply(ae(0, 'q', 'question', 'active'));
  assert.equal(q.snapshot().run, null);
});

test('activity: end without start still creates a run; late or earlier active does not reopen it', () => {
  const p = new PipelineTracker();
  p.apply(ae(5000, 'e', 'server_task', 'passed', { target: 'h' }, 'done'));
  let a = p.snapshot().activity_runs[0];
  assert.equal(a.state, 'passed');
  assert.equal(a.ended_ts, T0 + 5000);
  p.apply(ae(1000, 'e', 'server_task', 'active', { target: 'h' }, 'start text'));
  a = p.snapshot().activity_runs[0];
  assert.equal(a.state, 'passed', 'out-of-order active does not reopen');
  assert.equal(a.ended_ts, T0 + 5000);
  assert.equal(a.started_ts, T0 + 1000, 'but it fixes the start time');
  assert.equal(a.summary, 'done');
  // same-second start and end (script timestamps have 1s resolution)
  p.apply(ae(2000, 'f', 'question', 'passed'));
  p.apply(ae(2000, 'f', 'question', 'active'));
  assert.equal(p.snapshot().activity_runs.find((r) => r.run_id === 'f').state, 'passed');
});

test('activity: eviction and rebuild include kinds; list is newest first and capped', () => {
  const p = new PipelineTracker({ maxRuns: 3 });
  p.apply(pe(0, { step: 'spec', state: 'active' }));
  for (let i = 1; i <= 4; i++) p.apply(ae(i * 10, `q${i}`, 'question', 'passed'));
  assert.equal(p.runs.size, 3);
  assert.ok(p.runs.has('r1'), 'the current feature run is not evicted by activity churn');
  assert.deepEqual(
    p.snapshot().activity_runs.map((r) => r.run_id),
    ['q4', 'q3'],
  );
  const big = new PipelineTracker({ maxRuns: 100 });
  for (let i = 0; i < 30; i++) big.apply(ae(i, `n${i}`, 'question', 'active'));
  const list = big.snapshot().activity_runs;
  assert.equal(list.length, 20);
  assert.equal(list[0].run_id, 'n29');
  // rebuild: replaying the same events into a fresh tracker gives the same snapshot
  const evs = [
    ae(0, 'a', 'server_task', 'active', { target: 'h' }, 's'),
    ae(1, 'a', 'server_task', 'failed', { target: 'h' }, 'x'),
    pe(2, { step: 'spec', state: 'active' }),
  ];
  const one = new PipelineTracker();
  const two = new PipelineTracker();
  evs.forEach((x) => one.apply(x));
  evs.forEach((x) => two.apply(x));
  assert.deepEqual(one.snapshot(), two.snapshot());
  assert.equal(one.snapshot().activity_runs[0].kind, 'server_task');
});

// ---- active_steps -------------------------------------------------------------------------------

const act = (p) => p.snapshot().active_steps;
const fe = (ts, run_id, step, state, extra = {}) => ({
  ts,
  type: 'pipeline',
  agent: 'orchestrator',
  meta: { run_id, step, state, repo: 'example-app', ...extra },
});

test('active_steps: a single run lists its active step with only id fields', () => {
  const p = new PipelineTracker();
  p.apply(fe(1000, 'r1', 'test', 'active', { attempt: 2 }));
  assert.deepEqual(act(p), [
    { run_id: 'r1', repo: 'example-app', step: 'verify', substep: 'test', ts: 1000, attempt: 2 },
  ]);
  assert.deepEqual(Object.keys(act(p)[0]).sort(), ['attempt', 'repo', 'run_id', 'step', 'substep', 'ts']);
});

test('active_steps: parallel runs both listed, newest first; pass and fail remove the entry', () => {
  const p = new PipelineTracker();
  p.apply(fe(1000, 'a', 'test', 'active'));
  p.apply(fe(2000, 'b', 'security', 'active', { repo: 'other-app' }));
  assert.deepEqual(
    act(p).map((s) => [s.run_id, s.step]),
    [
      ['b', 'review'],
      ['a', 'verify'],
    ],
  );
  p.apply(fe(3000, 'a', 'verify', 'passed'));
  p.apply(fe(3100, 'b', 'security', 'failed'));
  assert.deepEqual(act(p), []);
});

test('active_steps: an earlier step re-activating resets later active steps; the run list keeps old fields', () => {
  const p = new PipelineTracker();
  p.apply(fe(1000, 'a', 'test', 'active'));
  p.apply(fe(1500, 'a', 'styling', 'active'));
  assert.equal(act(p).length, 1, 'both gates are substeps of one verify step');
  p.apply(fe(2000, 'a', 'code', 'active'));
  assert.deepEqual(
    act(p).map((s) => s.step),
    ['code'],
  );
  const snap = p.snapshot();
  assert.ok(snap.run && Array.isArray(snap.recent_runs) && Array.isArray(snap.activity_runs));
});

test('active_steps: evicted runs vanish; single_role runs count with the role as step', () => {
  const p = new PipelineTracker({ maxRuns: 2 });
  p.apply(fe(1000, 'a', 'test', 'active'));
  p.apply(fe(2000, 'b', 'security', 'active'));
  p.apply(fe(3000, 'c', 'styling', 'active'));
  assert.equal(
    act(p).some((s) => s.run_id === 'a'),
    false,
  );
  const q = new PipelineTracker();
  q.apply(ae(0, 'sr', 'single_role', 'active', { step: 'verify', target: 'example-app' }));
  q.apply(ae(1, 'sq', 'single_role', 'active', { step: 'review', target: 'example-app' }));
  q.apply(ae(2, 'sx', 'single_role', 'active', { step: 'bogus', target: 'example-app' }));
  q.apply(ae(3, 'qq', 'question', 'active', { step: 'test' }));
  assert.deepEqual(
    act(q)
      .map((s) => s.step)
      .sort(),
    ['review', 'verify'],
  );
  assert.deepEqual(
    act(q).map((s) => s.substep),
    [null, null],
  );
  q.apply(ae(4, 'sr', 'single_role', 'passed', { step: 'verify' }));
  assert.deepEqual(
    act(q).map((s) => s.step),
    ['review'],
  );
});

test('active_steps is bounded', () => {
  const p = new PipelineTracker({ maxRuns: 500 });
  for (let i = 0; i < 120; i++) p.apply(fe(1000 + i, `r${i}`, 'test', 'active'));
  assert.ok(act(p).length <= 50);
});

// ---- substeps -----------------------------------------------------------------------------------

const sub = (ts, step, substep, state, extra = {}, summary) =>
  pe(ts, { step, substep, state, ...extra }, summary);
const stepOf = (p, name) => p.snapshot().run.steps.find((s) => s.name === name);
const subOf = (p, name, sn) => stepOf(p, name).substeps.find((x) => x.name === sn);

test('substeps: the stepper has exactly 8 steps; verify and review carry canonical substeps', () => {
  const p = new PipelineTracker();
  p.apply(pe(0, { step: 'spec', state: 'active' }));
  const steps = p.snapshot().run.steps;
  assert.deepEqual(
    steps.map((s) => s.name),
    ['spec', 'code', 'verify', 'review', 'user-approval', 'merge', 'deploy', 'cleanup'],
  );
  assert.deepEqual(
    steps.find((s) => s.name === 'verify').substeps.map((x) => [x.name, x.state, x.ts, x.summary]),
    [
      ['test', 'pending', null, null],
      ['styling', 'pending', null, null],
    ],
  );
  assert.deepEqual(
    steps.find((s) => s.name === 'review').substeps.map((x) => x.name),
    ['security', 'code-review'],
  );
  assert.deepEqual(steps.find((s) => s.name === 'spec').substeps, []);
});

test('substeps: substep events, derived parent state, failed substep, no reset of other steps', () => {
  const p = new PipelineTracker();
  p.apply(pe(0, { step: 'code', state: 'passed' }));
  p.apply(sub(1, 'verify', 'test', 'active'));
  assert.equal(stepOf(p, 'verify').state, 'active');
  assert.equal(stepOf(p, 'code').state, 'passed', 'a substep event does not reset others');
  p.apply(sub(2, 'verify', 'test', 'passed'));
  p.apply(sub(3, 'verify', 'styling', 'active'));
  assert.deepEqual(
    act(p).map((s) => [s.step, s.substep]),
    [['verify', 'styling']],
  );
  p.apply(sub(4, 'verify', 'styling', 'failed', { attempt: 1 }, 'prettier: 3 files'));
  const r = p.snapshot().run;
  assert.equal(stepOf(p, 'verify').state, 'failed');
  assert.equal(r.failed_gate, 'styling');
  assert.equal(r.last_failure, 'prettier: 3 files');
  assert.deepEqual(act(p), []);
  // retry clears verify and review, parents and substeps
  p.apply(pe(5, { step: 'code', state: 'active', attempt: 2 }));
  assert.equal(stepOf(p, 'verify').state, 'pending');
  assert.equal(subOf(p, 'verify', 'test').state, 'pending');
});

test('substeps: parent-level active clears its substeps and resets later steps; passed ends the agent', () => {
  const p = new PipelineTracker();
  p.apply(sub(1, 'verify', 'test', 'passed'));
  p.apply(sub(1, 'review', 'security', 'active'));
  p.apply(pe(2, { step: 'verify', state: 'active' }));
  assert.equal(subOf(p, 'verify', 'test').state, 'pending');
  assert.equal(stepOf(p, 'review').state, 'pending');
  assert.equal(subOf(p, 'review', 'security').state, 'pending');
  p.apply(sub(3, 'verify', 'test', 'active'));
  p.apply(pe(4, { step: 'verify', state: 'passed' }));
  assert.equal(stepOf(p, 'verify').state, 'passed');
  assert.deepEqual(act(p), []);
  p.apply(pe(5, { step: 'review', state: 'failed' }));
  assert.equal(p.snapshot().run.failed_gate, 'review');
  p.apply(pe(6, { step: 'review', state: 'failed', failed_gate: 'security' }));
  assert.equal(p.snapshot().run.failed_gate, 'security');
});

test('substeps: legacy names normalise to the parent; mixed runs merge; implicit pass', () => {
  const p = new PipelineTracker();
  p.apply(pe(1, { step: 'test', state: 'active' }));
  assert.deepEqual(
    act(p).map((s) => [s.step, s.substep]),
    [['verify', 'test']],
  );
  assert.equal(stepOf(p, 'test'), undefined);
  p.apply(pe(2, { step: 'test', state: 'passed' }));
  p.apply(sub(3, 'verify', 'styling', 'passed'));
  assert.equal(stepOf(p, 'verify').state, 'active', 'no later step yet');
  assert.deepEqual(act(p), [], 'but nothing is running between legacy gates');
  p.apply(pe(4, { step: 'security', state: 'active' }));
  assert.equal(stepOf(p, 'verify').state, 'passed', 'implicit end once a later step is active');
  assert.equal(subOf(p, 'verify', 'test').state, 'passed');
  assert.equal(stepOf(p, 'review').state, 'active');
  // a legacy failure
  p.apply(pe(5, { step: 'code-review', state: 'failed', failed_gate: 'code-review' }, 'bug'));
  assert.equal(stepOf(p, 'review').state, 'failed');
  assert.equal(p.snapshot().run.failed_gate, 'code-review');
  // a legacy name with a substep field: the substep is dropped, the legacy name wins
  const q = new PipelineTracker();
  q.apply(pe(1, { step: 'test', substep: 'styling', state: 'active' }));
  assert.equal(subOf(q, 'verify', 'test').state, 'active');
  assert.equal(subOf(q, 'verify', 'styling').state, 'pending');
});

test('substeps: quick succession applies in arrival order; an older ts is ignored', () => {
  const p = new PipelineTracker();
  p.apply(sub(1000, 'verify', 'test', 'active'));
  p.apply(sub(1000, 'verify', 'test', 'passed'));
  assert.equal(subOf(p, 'verify', 'test').state, 'passed');
  p.apply(sub(500, 'verify', 'test', 'failed'));
  assert.equal(subOf(p, 'verify', 'test').state, 'passed');
  assert.equal(p.snapshot().run.failed_gate, null);
  assert.equal(stepOf(p, 'verify').substeps.length, 2);
});

test('substeps: invalid combinations are dropped without breaking the step', () => {
  const p = new PipelineTracker();
  p.apply(sub(1, 'verify', 'security', 'active'));
  assert.equal(stepOf(p, 'verify').state, 'active', 'step kept as sent');
  assert.deepEqual(
    stepOf(p, 'verify').substeps.map((x) => x.state),
    ['pending', 'pending'],
  );
  p.apply(sub(2, 'code', 'test', 'active'));
  assert.equal(stepOf(p, 'code').state, 'active');
  p.apply(sub(3, 'review', 'bogus', 'passed'));
  assert.equal(stepOf(p, 'review').state, 'passed');
  p.apply(sub(4, 'review', 'security', undefined));
  assert.equal(subOf(p, 'review', 'security').state, 'skipped', 'passed parent, substep never reported');
  p.apply(sub(5, 'review', { x: 1 }, 'active'));
  assert.ok(p.snapshot().run);
});

test('substeps: status failed for a failed substep at max attempts; waiting and complete as before', () => {
  const p = new PipelineTracker({ maxAttempts: 3 });
  p.apply(sub(1, 'review', 'security', 'failed', { attempt: 2 }));
  assert.equal(p.snapshot().run.status, 'running');
  p.apply(sub(2, 'review', 'security', 'failed', { attempt: 3 }));
  assert.equal(p.snapshot().run.status, 'failed');
  const q = new PipelineTracker();
  q.apply(pe(1, { step: 'user-approval', state: 'active' }));
  assert.equal(q.snapshot().run.status, 'waiting_approval');
  q.apply(pe(2, { step: 'cleanup', state: 'passed' }));
  assert.equal(q.snapshot().run.status, 'complete');
});

test('substeps: single_role maps legacy and substep forms; active_steps keys and parallel order', () => {
  const p = new PipelineTracker();
  p.apply(ae(1, 'a', 'single_role', 'active', { step: 'test', target: 'example-app' }));
  p.apply(ae(2, 'b', 'single_role', 'active', { step: 'verify', substep: 'styling', target: 'example-app' }));
  p.apply(ae(3, 'c', 'single_role', 'active', { step: 'verify', target: 'example-app' }));
  p.apply(ae(4, 'd', 'single_role', 'active', { step: 'cleanup', substep: 'test', target: 'example-app' }));
  const by = Object.fromEntries(act(p).map((s) => [s.run_id, [s.step, s.substep]]));
  assert.deepEqual(by, {
    a: ['verify', 'test'],
    b: ['verify', 'styling'],
    c: ['verify', null],
    d: ['cleanup', null],
  });
  assert.equal(p.snapshot().activity_runs.find((r) => r.run_id === 'a').role, 'test');
  for (const s of act(p))
    assert.deepEqual(Object.keys(s).sort(), ['attempt', 'repo', 'run_id', 'step', 'substep', 'ts']);
});

test('substeps: DB replay of old rows renders the new way', () => {
  const evs = [
    pe(1, { step: 'test', state: 'passed' }),
    pe(2, { step: 'styling', state: 'passed' }),
    pe(3, { step: 'security', state: 'active' }),
  ];
  const a = new PipelineTracker();
  const b = new PipelineTracker();
  evs.forEach((x) => a.apply(x));
  evs.forEach((x) => b.apply(x));
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(stepOf(a, 'verify').state, 'passed');
  assert.deepEqual(
    act(a).map((s) => [s.step, s.substep]),
    [['review', 'security']],
  );
});

test('single_role: a substep without a state is dropped, like in feature runs', () => {
  const p = new PipelineTracker();
  p.apply(ae(1, 'x', 'single_role', undefined, { step: 'verify', substep: 'test', target: 'example-app' }));
  p.apply(ae(2, 'x', 'single_role', 'active', { step: 'verify', target: 'example-app' }));
  assert.deepEqual(
    act(p).map((s) => [s.step, s.substep]),
    [['verify', null]],
  );
  p.apply(ae(3, 'y', 'single_role', 'active', { step: 'verify', substep: 'styling', target: 'example-app' }));
  assert.equal(act(p).find((s) => s.run_id === 'y').substep, 'styling');
});

test('skipped substeps: unseen substeps under a passed parent are skipped, else pending', () => {
  const subs = (p, step) =>
    Object.fromEntries(
      p
        .snapshot()
        .run.steps.find((s) => s.name === step)
        .substeps.map((x) => [x.name, x.state]),
    );
  const state = (p, step) => p.snapshot().run.steps.find((s) => s.name === step).state;

  // retry sequence: verify ran both gates, code restarted, review passed without re-running
  let p = new PipelineTracker();
  p.apply(pe(0, { step: 'verify', substep: 'test', state: 'passed' }));
  p.apply(pe(1, { step: 'verify', substep: 'styling', state: 'passed' }));
  p.apply(pe(2, { step: 'code', state: 'active', attempt: 2 }));
  p.apply(pe(3, { step: 'review', state: 'passed' }, 'unchanged, not re-run'));
  assert.equal(state(p, 'review'), 'passed');
  assert.deepEqual(subs(p, 'review'), { security: 'skipped', 'code-review': 'skipped' });

  // one recorded, one unseen: recorded keeps its state
  p = new PipelineTracker();
  p.apply(pe(0, { step: 'review', substep: 'security', state: 'passed' }));
  p.apply(pe(1, { step: 'review', state: 'passed' }));
  assert.deepEqual(subs(p, 'review'), { security: 'passed', 'code-review': 'skipped' });

  // parent failed: unseen stay pending
  p = new PipelineTracker();
  p.apply(pe(0, { step: 'review', state: 'failed' }));
  assert.equal(state(p, 'review'), 'failed');
  assert.deepEqual(subs(p, 'review'), { security: 'pending', 'code-review': 'pending' });

  // failed substep: recorded failed, unseen pending
  p = new PipelineTracker();
  p.apply(pe(0, { step: 'review', substep: 'security', state: 'failed' }));
  assert.deepEqual(subs(p, 'review'), { security: 'failed', 'code-review': 'pending' });

  // parent active or pending: unseen stay pending
  p = new PipelineTracker();
  p.apply(pe(0, { step: 'review', state: 'active' }));
  assert.deepEqual(subs(p, 'review'), { security: 'pending', 'code-review': 'pending' });
  p.apply(pe(1, { step: 'review', substep: 'security', state: 'active' }));
  assert.deepEqual(subs(p, 'review'), { security: 'active', 'code-review': 'pending' });
  assert.deepEqual(subs(p, 'verify'), { test: 'pending', styling: 'pending' });

  // implicit pass: seen substeps passed, later step active
  p = new PipelineTracker();
  p.apply(pe(0, { step: 'review', substep: 'security', state: 'passed' }));
  assert.equal(state(p, 'review'), 'active');
  assert.deepEqual(subs(p, 'review'), { security: 'passed', 'code-review': 'pending' });
  p.apply(pe(1, { step: 'user-approval', state: 'active' }));
  assert.equal(state(p, 'review'), 'passed');
  assert.deepEqual(subs(p, 'review'), { security: 'passed', 'code-review': 'skipped' });
  const r = p.snapshot().run;
  assert.ok(!JSON.stringify(r.status).includes('skipped'));
  assert.equal(r.status, 'waiting_approval');
  assert.equal(r.failed_gate, null);
});

// ---- abandoned runs (PIPELINE_STALE_MINUTES) ----
const MIN = 60000;
const mkp = () => new PipelineTracker({ maxAttempts: 3, staleMinutes: 60 });
const actEv = (ts, run_id, meta, summary) => ({
  ts: T0 + ts,
  agent: 'orchestrator',
  session_id: 'o',
  type: 'pipeline',
  summary,
  meta: { run_id, ...meta },
});

test('abandoned: stale feature run, its active steps and substeps; excluded from active_steps', () => {
  const p = mkp();
  p.apply(pe(0, { step: 'spec', state: 'passed', repo: 'x' }));
  p.apply(pe(MIN, { step: 'verify', state: 'active' }));
  p.apply(pe(2 * MIN, { step: 'verify', substep: 'test', state: 'active' }));
  let s = p.snapshot(T0 + 60 * MIN + 2 * MIN);
  assert.equal(s.run.status, 'running');
  assert.equal(s.active_steps.length, 1);
  s = p.snapshot(T0 + 2 * MIN + 60 * MIN); // exactly the threshold: strict >
  assert.equal(s.run.status, 'running');
  s = p.snapshot(T0 + 2 * MIN + 60 * MIN + 1);
  assert.equal(s.run.status, 'abandoned');
  assert.equal(s.run.abandoned, true);
  const verify = s.run.steps.find((x) => x.name === 'verify');
  assert.equal(verify.state, 'active');
  assert.equal(verify.abandoned, true);
  assert.equal(verify.substeps.find((x) => x.name === 'test').abandoned, true);
  assert.equal(s.recent_runs[0].status, 'abandoned');
  assert.deepEqual(s.active_steps, []);
  // passed steps carry no flag
  assert.equal(s.run.steps.find((x) => x.name === 'spec').abandoned, undefined);
});

test('abandoned: activity rows (question, server_task, single_role) and revival', () => {
  const p = mkp();
  p.apply(actEv(0, 'q', { kind: 'question', state: 'active', target: 'example-app' }, 'Why?'));
  p.apply(actEv(0, 's', { kind: 'server_task', state: 'active', target: 'docker' }));
  p.apply(actEv(0, 'r', { kind: 'single_role', step: 'verify', state: 'active', target: 'example-app' }));
  p.apply(actEv(0, 'done', { kind: 'question', state: 'passed' }));
  assert.equal(p.snapshot(T0 + 59 * MIN).activity_runs.find((r) => r.run_id === 'q').state, 'active');
  const s = p.snapshot(T0 + 61 * MIN);
  for (const id of ['q', 's', 'r']) {
    const r = s.activity_runs.find((x) => x.run_id === id);
    assert.equal(r.state, 'abandoned');
    assert.equal(r.abandoned, true);
    assert.equal(r.stale_since_ts, T0);
  }
  assert.equal(s.activity_runs.find((x) => x.run_id === 'done').state, 'passed');
  assert.deepEqual(s.active_steps, []);
  // a later event revives it
  p.apply(actEv(62 * MIN, 'q', { kind: 'question', state: 'active' }));
  const q = p.snapshot(T0 + 63 * MIN).activity_runs.find((x) => x.run_id === 'q');
  assert.equal(q.state, 'active');
  assert.equal(q.abandoned, undefined);
});

test('abandoned: a legacy step left active while other steps emit is abandoned alone; revival', () => {
  const p = mkp();
  p.apply(pe(0, { step: 'test', state: 'active' })); // legacy gate -> verify/test
  for (let i = 1; i <= 5; i++) p.apply(pe(i * 30 * MIN, { step: 'spec', state: 'passed' }));
  const now = T0 + 150 * MIN;
  const s = p.snapshot(now);
  assert.equal(s.run.status, 'running', 'run itself is recent');
  const verify = s.run.steps.find((x) => x.name === 'verify');
  assert.equal(verify.abandoned, true);
  assert.equal(verify.substeps.find((x) => x.name === 'test').abandoned, true);
  assert.deepEqual(s.active_steps, []);
  p.apply(pe(151 * MIN, { step: 'verify', substep: 'test', state: 'active' }));
  const v = p.snapshot(T0 + 152 * MIN).run.steps.find((x) => x.name === 'verify');
  assert.equal(v.abandoned, undefined);
  assert.equal(v.state, 'active');
  assert.equal(p.snapshot(T0 + 152 * MIN).active_steps.length, 1);
});

test('abandoned: user-approval, failed and complete runs are never abandoned by age', () => {
  const p = mkp();
  p.apply(pe(0, { step: 'user-approval', state: 'active' }));
  let s = p.snapshot(T0 + 1000 * MIN);
  assert.equal(s.run.status, 'waiting_approval');
  assert.equal(s.run.abandoned, undefined);
  assert.equal(s.run.steps.find((x) => x.name === 'user-approval').abandoned, undefined);

  const f = new PipelineTracker({ maxAttempts: 1, staleMinutes: 60 });
  f.apply(pe(0, { step: 'verify', state: 'failed', attempt: 1 }));
  f.apply(pe(MIN, { step: 'review', state: 'active' }));
  s = f.snapshot(T0 + 1000 * MIN);
  assert.equal(s.run.status, 'failed');
  assert.equal(s.run.abandoned, undefined);
  assert.equal(s.run.steps.find((x) => x.name === 'review').abandoned, undefined);

  const c = mkp();
  c.apply(pe(0, { step: 'cleanup', state: 'passed' }));
  s = c.snapshot(T0 + 1000 * MIN);
  assert.equal(s.run.status, 'complete');
});

test('abandoned: a run that keeps getting events within the threshold never abandons', () => {
  const p = mkp();
  p.apply(pe(0, { step: 'code', state: 'active' }));
  for (let t = 50; t <= 400; t += 50) {
    p.apply(pe(t * MIN, { step: 'code', state: 'active' }));
    const s = p.snapshot(T0 + t * MIN + 10 * MIN);
    assert.equal(s.run.status, 'running');
    assert.equal(s.run.steps.find((x) => x.name === 'code').abandoned, undefined);
    assert.equal(s.active_steps.length, 1);
  }
});

test('abandoned: snapshot() never mutates tracker state', () => {
  const p = mkp();
  p.apply(pe(0, { step: 'code', state: 'active' }));
  const before = JSON.stringify([...p.runs.values()]);
  p.snapshot(T0 + 1000 * MIN);
  assert.equal(JSON.stringify([...p.runs.values()]), before);
});

// ---- multi-run panels (`runs`)
const rp = (ts, run_id, meta) =>
  pe(ts, { run_id, repo: `repo-${run_id}`, branch: `feat/${run_id}`, ...meta });
const finish = (p, id, ts) => p.apply(rp(ts, id, { step: 'cleanup', state: 'passed' }));

test('runs: two concurrent runs are independent and run stays the last-emitting one', () => {
  const p = new PipelineTracker({ maxAttempts: 3 });
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active', attempt: 2 }));
  p.apply(rp(1, 'run-b', { step: 'user-approval', state: 'active' }));
  p.apply(rp(2, 'run-a', { step: 'verify', state: 'active' }));
  const s = p.snapshot(T0 + 3);
  assert.deepEqual(
    s.runs.map((r) => r.run_id),
    ['run-a', 'run-b'],
  );
  assert.equal(s.runs[0].attempt, 2);
  assert.equal(s.runs[0].waiting_on_user_approval, false);
  assert.equal(s.runs[1].waiting_on_user_approval, true);
  assert.equal(s.runs[1].repo, 'repo-run-b');
  assert.equal(s.run.run_id, 'run-a');
});

test('runs: capped at 8, dropping the least recently updated; order is stable by start time', () => {
  const p = new PipelineTracker();
  for (let i = 1; i <= 9; i++) p.apply(rp(i, `run-${i}`, { step: 'code', state: 'active' }));
  // the oldest run is updated again, so run-2 is now the least recently updated
  p.apply(rp(20, 'run-1', { step: 'verify', state: 'active' }));
  const s = p.snapshot(T0 + 30);
  assert.equal(s.runs.length, 8);
  assert.ok(!s.runs.some((r) => r.run_id === 'run-2'));
  assert.deepEqual(
    s.runs.map((r) => r.run_id),
    ['run-1', 'run-3', 'run-4', 'run-5', 'run-6', 'run-7', 'run-8', 'run-9'],
  );
  assert.equal(JSON.stringify(p.snapshot(T0 + 30)), JSON.stringify(s));
});

test('runs: ties on started_ts are ordered by run_id', () => {
  const p = new PipelineTracker();
  p.apply(rp(0, 'run-b', { step: 'code', state: 'active' }));
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active' }));
  assert.deepEqual(
    p.snapshot(T0 + 1).runs.map((r) => r.run_id),
    ['run-a', 'run-b'],
  );
});

test('runs: complete and failed runs leave after the grace period but stay in run and recent_runs', () => {
  const p = new PipelineTracker({ maxAttempts: 3 });
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active' }));
  finish(p, 'run-a', 1000);
  p.apply(rp(2000, 'run-f', { step: 'security', state: 'failed', attempt: 3 }));
  p.apply(rp(3000, 'run-r', { step: 'code', state: 'active' }));
  const grace = PANEL_GRACE_MINUTES * 60000;
  let s = p.snapshot(T0 + 3000 + grace - 10000);
  assert.deepEqual(s.runs.map((r) => r.run_id).sort(), ['run-a', 'run-f', 'run-r']);
  s = p.snapshot(T0 + 3000 + grace + 1);
  assert.ok(!s.runs.some((r) => r.run_id === 'run-a'));
  assert.ok(!s.runs.some((r) => r.run_id === 'run-f'));
  assert.ok(s.runs.some((r) => r.run_id === 'run-r'));
  assert.equal(s.run.run_id, 'run-r');
  assert.ok(s.recent_runs.some((r) => r.run_id === 'run-a' && r.status === 'complete'));
  assert.ok(s.recent_runs.some((r) => r.run_id === 'run-f' && r.status === 'failed'));
});

test('runs: an abandoned run inside the window and a waiting run at any age are kept', () => {
  const p = new PipelineTracker({ staleMinutes: 60 });
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active' }));
  p.apply(rp(1, 'run-w', { step: 'user-approval', state: 'active' }));
  const s = p.snapshot(T0 + 90 * 60000);
  assert.equal(s.runs.find((r) => r.run_id === 'run-a').status, 'abandoned');
  assert.equal(s.runs.find((r) => r.run_id === 'run-w').status, 'waiting_approval');
  const late = p.snapshot(T0 + 1364 * 60000);
  assert.ok(!late.runs.some((r) => r.run_id === 'run-a'));
  assert.equal(late.runs.find((r) => r.run_id === 'run-w').status, 'waiting_approval');
});

test('runs: abandoned window boundary is inclusive and measured from the last event', () => {
  const p = new PipelineTracker({ staleMinutes: 60 });
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active' }));
  const win = PANEL_ABANDONED_MINUTES * 60000;
  const at = p.snapshot(T0 + win);
  assert.equal(at.runs.find((r) => r.run_id === 'run-a').status, 'abandoned');
  assert.ok(!p.snapshot(T0 + win + 1).runs.some((r) => r.run_id === 'run-a'));
});

test('runs: an aged-out abandoned run returns on a new event', () => {
  const p = new PipelineTracker({ staleMinutes: 60 });
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active' }));
  const later = PANEL_ABANDONED_MINUTES * 60000 + 5000;
  assert.ok(!p.snapshot(T0 + later).runs.some((r) => r.run_id === 'run-a'));
  p.apply(rp(later, 'run-a', { step: 'code', state: 'active' }));
  const s = p.snapshot(T0 + later + 1000);
  assert.equal(s.runs.find((r) => r.run_id === 'run-a').status, 'running');
});

test('runs: a long-silent abandoned run is not a panel but stays in recent_runs', () => {
  const p = new PipelineTracker({ staleMinutes: 60 });
  p.apply(rp(0, 'run-a', { step: 'code', state: 'active' }));
  const s = p.snapshot(T0 + 1364 * 60000);
  assert.deepEqual(s.runs, []);
  assert.ok(s.recent_runs.some((r) => r.run_id === 'run-a' && r.status === 'abandoned'));
});

test('runs: non-feature runs are excluded', () => {
  const p = new PipelineTracker();
  p.apply(ae(0, 'q1', 'question', 'active', { target: 'example-app' }));
  p.apply(rp(1, 'run-a', { step: 'code', state: 'active' }));
  const s = p.snapshot(T0 + 2);
  assert.deepEqual(
    s.runs.map((r) => r.run_id),
    ['run-a'],
  );
  assert.equal(s.activity_runs.length, 1);
});
