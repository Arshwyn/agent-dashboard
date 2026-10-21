'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveRole,
  describeTool,
  buildEvent,
  buildLinkEvent,
  sumTranscriptUsage,
  curlConfig,
} = require('../scripts/lib/hook-lib');
const { validateEvent } = require('../src/schema');
const { tempDir } = require('./helpers');

test('role resolution: env > named agent_type > agent_id > cwd > unknown; unnamed subagents are helper', () => {
  assert.equal(resolveRole({ agent_type: 'security', cwd: '/x' }, { AGENT_DASHBOARD_ROLE: 'spec' }), 'spec');
  assert.equal(resolveRole({ agent_type: 'security', agent_id: 'a1' }, {}), 'security');
  assert.equal(
    resolveRole({ agent_type: 'general-purpose', agent_id: 'a1', cwd: '/work/orchestrator' }, {}),
    'helper',
  );
  assert.equal(resolveRole({ agent_type: '', agent_id: 'a1' }, {}), 'helper');
  assert.equal(resolveRole({ agent_id: 'a1' }, {}), 'helper');
  assert.equal(resolveRole({ cwd: '/work/orchestrator' }, {}), 'orchestrator');
  assert.equal(resolveRole({ cwd: '/work/server-ops' }, {}), 'server-ops');
  assert.equal(resolveRole({ cwd: '/somewhere' }, {}), 'unknown');
  assert.equal(resolveRole({ cwd: '/somewhere' }, { AGENT_DASHBOARD_ROLE: 'bad role!' }), 'unknown');
});

test('describeTool gives only a short redacted descriptor', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b.js', content: 'SECRET' }), 'Read: /a/b.js');
  const d = describeTool('Bash', { command: 'export API_KEY=abc123 && ' + 'z'.repeat(300) });
  assert.ok(d.length < 100 && !d.includes('abc123'));
  assert.equal(
    describeTool('WebFetch', { url: 'https://example.com/path?token=1' }),
    'WebFetch: example.com',
  );
  assert.equal(describeTool('mcp__x__y', { anything: 1 }), 'mcp__x__y');
});

test('buildEvent maps hook events to schema-valid dashboard events', () => {
  const base = { session_id: 'sess1', cwd: '/work/orchestrator' };
  const cases = [
    [
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      'tool_start',
    ],
    [
      {
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/a' },
        tool_response: { content: 'BIG' },
      },
      'tool_end',
    ],
    [{ ...base, hook_event_name: 'Stop' }, 'stop'],
    [
      {
        ...base,
        hook_event_name: 'Notification',
        message: 'Claude needs your permission',
        notification_type: 'permission_prompt',
      },
      'notification',
    ],
    [{ ...base, hook_event_name: 'SubagentStop', agent_type: 'test', agent_id: 'abc' }, 'subagent_stop'],
  ];
  for (const [input, type] of cases) {
    const e = buildEvent(input, {});
    assert.equal(e.type, type);
    assert.ok(validateEvent(e).ok, JSON.stringify(e));
    assert.ok(!JSON.stringify(e).includes('BIG'));
  }
  assert.equal(buildEvent({ hook_event_name: 'SessionStart' }, {}), null);
  assert.equal(buildEvent(null, {}), null);
});

test('subagent_stop sums transcript usage (numbers only), tolerating malformed lines', (t) => {
  const f = path.join(tempDir(t), 't.jsonl');
  fs.writeFileSync(
    f,
    [
      JSON.stringify({
        uuid: '1',
        message: {
          id: 'm1',
          usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 },
          content: 'PRIVATE TEXT',
        },
      }),
      'not json "usage"',
      JSON.stringify({
        uuid: '2',
        message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 } },
      }),
      JSON.stringify({ uuid: '3', message: { id: 'm2', usage: { input_tokens: 1, output_tokens: 2 } } }),
    ].join('\n'),
  );
  assert.deepEqual(sumTranscriptUsage(f), {
    tokens_in: 16,
    tokens_out: 9,
    usage: {
      unknown: { input: 11, output: 9, cache_write_5m: 5, cache_write_1h: 0, cache_read: 0 },
    },
  });
  assert.equal(sumTranscriptUsage('/nonexistent/file'), null);
  const e = buildEvent(
    { hook_event_name: 'SubagentStop', session_id: 's', agent_type: 'code', agent_transcript_path: f },
    {},
  );
  assert.equal(e.tokens_in, 16);
  assert.ok(!JSON.stringify(e).includes('PRIVATE'));
});

test('curl config escapes quotes and keeps the token out of argv', () => {
  const cfg = curlConfig({ url: 'http://h/event', token: 'tok"en', body: '{"a":"b\\"c"}' });
  assert.match(cfg, /tok\\"en/);
  assert.match(cfg, /max-time = 2/);
});

function writeTranscript(t, lines) {
  const f = path.join(tempDir(t), 't.jsonl');
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return f;
}

test('sumTranscriptUsage groups by model, splits cache TTLs, keeps cache reads and dedupes', (t) => {
  const f = writeTranscript(t, [
    {
      uuid: 'a',
      message: {
        id: 'm1',
        model: 'claude-sonnet-5-5',
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
          cache_read_input_tokens: 4000,
        },
        content: 'PRIVATE',
      },
    },
    // same message again with its final output count: counted once, max per class
    {
      uuid: 'b',
      message: {
        id: 'm1',
        model: 'claude-sonnet-5-5',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
          cache_read_input_tokens: 4000,
        },
      },
    },
    // no TTL split: all cache writes are 5m
    {
      uuid: 'c',
      message: {
        id: 'm2',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7 },
      },
    },
    // synthetic zero-usage message is dropped
    { uuid: 'd', message: { id: 'm3', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } },
    { uuid: 'e', message: { id: 'm4', model: 'bad model!', usage: { input_tokens: 1 } } },
  ]);
  const r = sumTranscriptUsage(f);
  assert.deepEqual(r.usage['claude-sonnet-5-5'], {
    input: 100,
    output: 50,
    cache_write_5m: 200,
    cache_write_1h: 100,
    cache_read: 4000,
  });
  assert.deepEqual(r.usage['claude-haiku-4-5-20251001'], {
    input: 5,
    output: 6,
    cache_write_5m: 7,
    cache_write_1h: 0,
    cache_read: 0,
  });
  assert.deepEqual(r.usage.unknown, {
    input: 1,
    output: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  });
  assert.equal(r.usage['<synthetic>'], undefined);
  assert.equal(r.tokens_in, 100 + 300 + 5 + 7 + 1);
  assert.equal(r.tokens_out, 56);
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});

test('top-level Stop sends a cumulative snapshot; subagent Stop and unreadable transcripts do not', (t) => {
  const f = writeTranscript(t, [
    {
      uuid: 'a',
      message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 4 } },
    },
  ]);
  const base = { session_id: 's', cwd: '/work/orchestrator', hook_event_name: 'Stop' };
  const e = buildEvent({ ...base, transcript_path: f }, {});
  assert.equal(e.usage_scope, 'session_cumulative');
  assert.deepEqual(e.usage['claude-opus-5-5'].input, 3);
  assert.ok(validateEvent(e).ok);
  const sub = buildEvent({ ...base, agent_id: 'x', agent_type: 'code', transcript_path: f }, {});
  assert.equal(sub.usage, undefined);
  const bad = buildEvent({ ...base, transcript_path: '/nonexistent/t.jsonl' }, {});
  assert.equal(bad.usage, undefined);
  assert.equal(bad.type, 'stop');
  const sa = buildEvent(
    { ...base, hook_event_name: 'SubagentStop', agent_id: 'x', agent_type: 'code', agent_transcript_path: f },
    {},
  );
  assert.equal(sa.usage_scope, undefined);
  assert.ok(validateEvent(sa).ok);
});

// ---------------------------------------------------------------- run links

const SPAWN_PROMPT = 'Do the thing.\nrun-id: alpha-1000000001-1001\nSECRET-PROMPT-TEXT here';
const spawnInput = (over = {}, ti = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'p1',
  tool_name: 'Agent',
  tool_input: { subagent_type: 'verify', description: 'Verify it', prompt: SPAWN_PROMPT, ...ti },
  tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1b2c3' },
  ...over,
});

test('buildLinkEvent: a background spawn with one run-id line links the subagent session', () => {
  const l = buildLinkEvent(spawnInput(), {}, 5000);
  assert.deepEqual(l, {
    ts: 5000,
    agent: 'verify',
    session_id: 'p1:a1b2c3',
    type: 'link',
    meta: { run_id: 'alpha-1000000001-1001' },
  });
  assert.ok(!JSON.stringify(l).includes('SECRET-PROMPT-TEXT'), 'the prompt is never sent');
  assert.ok(validateEvent(l, 5000).ok, 'the server accepts it');
  assert.deepEqual(validateEvent(l, 5000).event.meta, { run_id: 'alpha-1000000001-1001' });
});

test('buildLinkEvent: Task, status-only and agent_id responses link; old and new run id formats work', () => {
  const task = buildLinkEvent(spawnInput({ tool_name: 'Task' }), {}, 1);
  assert.equal(task.session_id, 'p1:a1b2c3');
  const statusOnly = buildLinkEvent(
    spawnInput({ tool_response: { status: 'async_launched', agent_id: 'x9' } }),
    {},
    1,
  );
  assert.equal(statusOnly.session_id, 'p1:x9');
  for (const id of ['example-app-1000000001', 'example-app-1000000001-ab12']) {
    const l = buildLinkEvent(spawnInput({}, { prompt: `run-id: ${id}\r\nmore` }), {}, 1);
    assert.equal(l.meta.run_id, id);
  }
  assert.equal(buildLinkEvent(spawnInput({}, { prompt: 'run-id: r1\nrun-id: r1' }), {}, 1).meta.run_id, 'r1');
  assert.equal(buildLinkEvent(spawnInput({}, { subagent_type: 'general-purpose' }), {}, 1).agent, 'helper');
  assert.equal(buildLinkEvent(spawnInput({}, { subagent_type: undefined }), {}, 1).agent, 'helper');
});

test('buildLinkEvent: no link for foreground spawns, missing or ambiguous run ids, bad ids or no agent id', () => {
  const no = (input) => assert.equal(buildLinkEvent(input, {}, 1), null, JSON.stringify(input).slice(0, 120));
  no(spawnInput({ tool_response: { status: 'completed', content: 'done' } }));
  no(spawnInput({ tool_response: { isAsync: false, agentId: 'a1' } }));
  no(spawnInput({ tool_response: 'text' }));
  no(spawnInput({ tool_response: undefined }));
  no(spawnInput({ tool_response: { isAsync: true } }));
  no(spawnInput({ tool_response: { isAsync: true, agentId: 'bad id!' } }));
  no(spawnInput({ tool_response: { isAsync: true, agentId: 'a'.repeat(65) } }));
  no(spawnInput({}, { prompt: 'no id here' }));
  no(spawnInput({}, { prompt: 'see run-id: x in text' }));
  no(spawnInput({}, { prompt: 'run-id: a\nrun-id: b' }));
  no(spawnInput({}, { prompt: 'run-id: ok-1\nrun-id: bad id' }));
  no(spawnInput({}, { prompt: 'run-id: ' + 'a'.repeat(81) }));
  no(spawnInput({}, { prompt: 'run-id: a/b' }));
  no(spawnInput({}, { prompt: 5 }));
  no(spawnInput({ tool_input: undefined }));
  no(spawnInput({ tool_name: 'Bash' }));
  no(spawnInput({ hook_event_name: 'PreToolUse' }));
  no(null);
});

test('buildEvent output for a spawn is unchanged by the link support', () => {
  const ev = buildEvent(spawnInput(), {}, 7);
  assert.deepEqual(ev, {
    ts: 7,
    agent: 'unknown',
    session_id: 'p1',
    type: 'tool_end',
    tool: 'Agent',
    summary: 'Agent: verify: Verify it',
  });
});

test('hook.js sends the main event and the link as two requests and exits 0; fails open', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const run = (url, payload) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'hook.js')], {
        env: {
          PATH: process.env.PATH,
          AGENT_DASHBOARD_ENV_FILE: '/nonexistent/hook.env',
          AGENT_DASHBOARD_URL: url,
          AGENT_DASHBOARD_INGEST_TOKEN: 'tok-not-a-real-secret-0000',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('close', (code) => resolve(code));
      child.stdin.end(JSON.stringify(payload));
    });
  try {
    assert.equal(await run(`http://127.0.0.1:${srv.address().port}`, spawnInput()), 0);
    for (let i = 0; i < 100 && bodies.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(bodies.map((b) => b.type).sort(), ['link', 'tool_end']);
    const l = bodies.find((b) => b.type === 'link');
    assert.deepEqual(l.meta, { run_id: 'alpha-1000000001-1001' });
    assert.ok(!JSON.stringify(bodies).includes('SECRET-PROMPT-TEXT'));
    // Nothing is listening: still exit 0.
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    assert.equal(await run(`http://127.0.0.1:${port}`, spawnInput()), 0);
    assert.equal(await run('http://127.0.0.1:1', { hook_event_name: 'Stop' }), 0);
  } finally {
    srv.close();
  }
});
