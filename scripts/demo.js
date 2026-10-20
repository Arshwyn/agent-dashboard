#!/usr/bin/env node
'use strict';
// Posts synthetic events so the UI can be verified without real agents.
//   INGEST_TOKEN=... DEMO_URL=http://127.0.0.1:8787 npm run demo [-- --fast]
const url = (process.env.DEMO_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, '');
const token = process.env.INGEST_TOKEN;
const fast = process.argv.includes('--fast');
const delay = (ms) => new Promise((r) => setTimeout(r, fast ? 0 : ms));
const run_id = `demo-${Date.now().toString(36)}`;
const repo = 'demo-repo';
const branch = 'feat/demo';

if (!token) {
  console.error('INGEST_TOKEN env var is required (same value the server uses).');
  process.exit(1);
}

// Pipeline roles are subagents (session `<sid>:<agent_id>`): the server hands each to a named person.
async function post(ev) {
  const res = await fetch(`${url}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ts: Date.now(),
      session_id: ev.agent === 'orchestrator' ? 'demo-orchestrator' : `demo-run:${ev.agent}`,
      ...ev,
    }),
  });
  if (!res.ok) throw new Error(`POST /event -> ${res.status} ${await res.text()}`);
}

const pipe = (step, state, extra = {}, summary) =>
  post({
    agent: 'orchestrator',
    type: 'pipeline',
    summary,
    meta: { run_id, step, state, repo, branch, ...extra },
  });

const activity = (id, kind, state, target, summary, extra = {}) =>
  post({
    agent: 'orchestrator',
    type: 'pipeline',
    summary,
    meta: { run_id: `${run_id}-${id}`, kind, state, target, ...extra },
  });

// Realistic per-model usage (with prompt-cache writes and reads) for a subagent transcript.
function demoUsage(tokens) {
  const usage = {
    'claude-sonnet-5-5': {
      input: Math.round(tokens * 0.1),
      output: Math.round(tokens / 4),
      cache_write_5m: Math.round(tokens * 0.4),
      cache_write_1h: Math.round(tokens * 0.1),
      cache_read: tokens * 6,
    },
  };
  if (tokens > 10000) {
    usage['claude-haiku-4-5-20251001'] = {
      input: Math.round(tokens * 0.05),
      output: Math.round(tokens / 20),
    };
  }
  return usage;
}

async function work(agent, task, tools, tokens) {
  await post({ agent, type: 'status', task, repo, branch, summary: 'starting' });
  for (const [tool, summary] of tools) {
    await post({ agent, type: 'tool_start', tool, summary: `${tool}: ${summary}`, task });
    await delay(700);
    await post({ agent, type: 'tool_end', tool, summary: `${tool}: ${summary}`, task });
  }
  await post({
    agent,
    type: 'subagent_stop',
    summary: 'finished',
    usage: demoUsage(tokens), // the server prices it; the sender never supplies a cost
  });
}

// The orchestrator reports a cumulative snapshot on every Stop; the server keeps only the delta.
const orchestratorTotal = { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };
async function orchestratorStop(grow = true) {
  if (grow) {
    orchestratorTotal.input += 1200;
    orchestratorTotal.output += 900;
    orchestratorTotal.cache_write_5m += 8000;
    orchestratorTotal.cache_read += 150000;
  }
  await post({
    agent: 'orchestrator',
    session_id: 'demo-orchestrator',
    type: 'stop',
    summary: 'turn finished',
    usage: { 'claude-opus-5-5': { ...orchestratorTotal } },
    usage_scope: 'session_cumulative',
  });
}

async function main() {
  console.log(`demo run ${run_id} -> ${url}`);
  // One of each non-feature kind: question, server task (failed), single role.
  await activity('q', 'question', 'active', repo, 'How does the ingest token get validated?');
  await activity('s', 'server_task', 'active', 'app-server', 'Restart the nginx container');
  await activity('r', 'single_role', 'active', repo, 'Run test on demo-repo', { step: 'verify' });
  await delay(1500);
  await activity('q', 'question', 'passed', repo, 'Answered from src/auth.js');
  await activity('s', 'server_task', 'failed', 'app-server', 'nginx did not become healthy');
  await activity('r', 'single_role', 'passed', repo, 'npm test: 59 passing', { step: 'verify' });
  await pipe('spec', 'active');
  await work(
    'spec',
    'Write task brief',
    [
      ['Read', 'README.md'],
      ['Write', 'TASK.md'],
    ],
    12000,
  );
  await orchestratorStop();
  await pipe('spec', 'passed');
  await pipe('code', 'active', { attempt: 1 });
  await work(
    'code',
    'Implement feature',
    [
      ['Read', 'src/index.js'],
      ['Edit', 'src/index.js'],
      ['Bash', 'git commit -m wip'],
    ],
    48000,
  );
  await orchestratorStop();
  await orchestratorStop(false); // a repeated Stop with nothing new adds no cost
  await pipe('code', 'passed', {
    pr_url: 'https://github.com/example/demo/pull/1',
    commit_sha: 'abc1234def',
  });
  await pipe('verify', 'active');
  await pipe('verify', 'active', { substep: 'test' });
  await work('verify', 'Run test suite', [['Bash', 'npm test']], 9000);
  await pipe('verify', 'failed', { substep: 'test', attempt: 1 }, 'npm test: 2 failing (auth.test.js)');
  await post({
    agent: 'review',
    type: 'notification',
    summary: 'Claude needs your permission to use Bash',
  });
  await pipe('code', 'active', { attempt: 2 });
  await work('code', 'Fix failing tests', [['Edit', 'src/auth.js']], 15000);
  await pipe('code', 'passed', { attempt: 2 });
  // The merged agents: the stepper shows verify and review; the gate work (test, styling, security,
  // code-review) is a substep that drives the card label and the sprite icon.
  const gateParent = { test: 'verify', styling: 'verify', security: 'review', 'code-review': 'review' };
  // a second run in parallel (another repo) and a run that still uses a legacy gate name
  // (pipeline-only: legacy names are mapped to verify / review and never create a card)
  const other = { run_id: `${run_id}-b`, repo: 'other-repo' };
  const legacy = { run_id: `${run_id}-legacy`, repo: 'legacy-repo' };
  await pipe('verify', 'active', other);
  await pipe('verify', 'active', { ...other, substep: 'test' });
  await pipe('security', 'active', legacy); // legacy name, no substep: shown as review / security
  await work('review', 'Legacy gate: security', [['Bash', 'check security']], 4000);
  await pipe('security', 'passed', legacy);
  for (const parent of ['verify', 'review']) {
    await pipe(parent, 'active', { attempt: 2 });
    for (const gate of Object.keys(gateParent).filter((g) => gateParent[g] === parent)) {
      await pipe(parent, 'active', { attempt: 2, substep: gate });
      await work(parent, `Gate: ${gate}`, [['Bash', `check ${gate}`]], 7000);
      await pipe(parent, 'passed', { attempt: 2, substep: gate });
    }
    await pipe(parent, 'passed', { attempt: 2 });
  }
  await pipe('verify', 'passed', { ...other, substep: 'test' });
  await pipe('verify', 'passed', other);
  await pipe('user-approval', 'active', { attempt: 2 }, 'All gates clean');
  console.log('waiting on user approval (pipeline view should show the banner)...');
  await delay(6000);
  await pipe('user-approval', 'passed', { attempt: 2 });
  await pipe('merge', 'passed', { attempt: 2, commit_sha: 'fedcba9876' });
  await pipe('deploy', 'active', { attempt: 2 });
  await work('server-ops', 'Deploy to app-server', [['Bash', 'docker compose up -d']], 20000);
  await pipe('deploy', 'passed', { attempt: 2, deploy_result: 'success' });
  await pipe('cleanup', 'active', { attempt: 2 });
  await work('cleanup', 'Delete branch and task brief', [['Bash', 'git branch -d feat/demo']], 4000);
  await pipe('cleanup', 'passed', { attempt: 2 });
  console.log('demo complete');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
