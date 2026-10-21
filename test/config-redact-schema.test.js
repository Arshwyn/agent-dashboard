'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { redactString, sanitizeMeta, REDACTED } = require('../src/redact');
const { validateEvent } = require('../src/schema');

const GOOD_A = 'a3f9c1d27b8e4056aa11';
const GOOD_B = 'b7e2d4c91f3a5068bb22';

test('config refuses to start with missing, short, default or identical tokens', () => {
  assert.throws(() => loadConfig({}), /not set/);
  assert.throws(() => loadConfig({ INGEST_TOKEN: 'short', DASHBOARD_TOKEN: GOOD_B }), /at least 20/);
  assert.throws(
    () => loadConfig({ INGEST_TOKEN: 'changeme-changeme-changeme', DASHBOARD_TOKEN: GOOD_B }),
    /placeholder/,
  );
  assert.throws(() => loadConfig({ INGEST_TOKEN: GOOD_A, DASHBOARD_TOKEN: GOOD_A }), /different/);
  assert.throws(
    () => loadConfig({ INGEST_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa', DASHBOARD_TOKEN: GOOD_B }),
    /variety/,
  );
  const c = loadConfig({ INGEST_TOKEN: GOOD_A, DASHBOARD_TOKEN: GOOD_B });
  assert.deepEqual(c.agents, ['orchestrator']);
  assert.equal(c.port, 8787);
});

test('AGENT_DISPLAY_NAMES defaults to empty and is strictly validated', () => {
  const base = { INGEST_TOKEN: GOOD_A, DASHBOARD_TOKEN: GOOD_B };
  const load = (v, extra = {}) => loadConfig({ ...base, ...extra, AGENT_DISPLAY_NAMES: v });
  assert.deepEqual(loadConfig(base).agentDisplayNames, {});
  assert.deepEqual(load('').agentDisplayNames, {});
  assert.deepEqual(load('   ').agentDisplayNames, {});
  assert.deepEqual(load('orchestrator=Example Bot').agentDisplayNames, { orchestrator: 'Example Bot' });
  assert.deepEqual(load(' orchestrator = Example Bot ', { AGENTS: 'orchestrator,ask' }).agentDisplayNames, {
    orchestrator: 'Example Bot',
  });
  assert.deepEqual(
    load('orchestrator=Alice AI,ask=Bob.2', { AGENTS: 'orchestrator,ask' }).agentDisplayNames,
    {
      orchestrator: 'Alice AI',
      ask: 'Bob.2',
    },
  );
  assert.throws(() => load('spec=Example Bot'), /key "spec".*AGENTS/);
  assert.throws(() => load('test=Example Bot', { AGENTS: 'orchestrator,test' }), /key "test"/);
  assert.throws(() => load('Ada=Example Bot'), /key "Ada"/, 'persons are never relabelled');
  assert.throws(() => load('orchestrator=A,orchestrator=B'), /more than once/);
  assert.throws(() => load('orchestrator'), /id=Label/);
  assert.throws(() => load('orchestrator=Example Bot,'), /id=Label/);
  assert.throws(() => load('orchestrator=' + 'x'.repeat(33)), /orchestrator/);
  assert.equal(load('orchestrator=' + 'x'.repeat(32)).agentDisplayNames.orchestrator.length, 32);
  assert.throws(() => load('orchestrator='), /orchestrator/);
  for (const bad of ['<b>', 'a>b', 'a&b', 'a"b', "a'b", 'a=b', 'a,b', '-lead', 'caf\u00e9', 'a\nb']) {
    assert.throws(() => load(`orchestrator=${bad}`), /AGENT_DISPLAY_NAMES/, bad);
  }
  assert.throws(() => load('orchestrator=<img src=x onerror=1>'), /AGENT_DISPLAY_NAMES/);
  try {
    load('orchestrator=Secret<Label>');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!e.message.includes('Secret'), 'error must not echo the label');
  }
});

test('PIPELINE_STALE_MINUTES defaults to 60, must be an integer >= 1', () => {
  const base = { INGEST_TOKEN: GOOD_A, DASHBOARD_TOKEN: GOOD_B };
  assert.equal(loadConfig(base).pipelineStaleMinutes, 60);
  assert.equal(loadConfig({ ...base, PIPELINE_STALE_MINUTES: '15' }).pipelineStaleMinutes, 15);
  for (const bad of ['0', '-1', 'abc']) {
    assert.throws(() => loadConfig({ ...base, PIPELINE_STALE_MINUTES: bad }), /PIPELINE_STALE_MINUTES/);
  }
});

test('AGENT_NAMES, AGENT_COOLDOWN_SECONDS and HANDOFF_WINDOW_SECONDS have defaults and are validated', () => {
  const base = { INGEST_TOKEN: GOOD_A, DASHBOARD_TOKEN: GOOD_B };
  const c = loadConfig(base);
  assert.deepEqual(c.agentNames, ['Ada', 'Bram', 'Carl', 'Dax', 'Ena', 'Finn', 'Gia', 'Hugo']);
  assert.deepEqual(loadConfig({ ...base, AGENT_NAMES: ' Xi , Yu ' }).agentNames, ['Xi', 'Yu']);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'Ok,bad name' }), /AGENT_NAMES/);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'Ok,ok' }), /repeat/);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: ',' }), /AGENT_NAMES/);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'Ok,Code', AGENTS: 'code' }), /clashes/);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'extra-1' }), /extra-1/);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'Ok,EXTRA-2' }), /EXTRA-2/);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'extra-100' }), /extra-100/);
  assert.deepEqual(loadConfig({ ...base, AGENT_NAMES: 'extra,extra1' }).agentNames, ['extra', 'extra1']);
  assert.throws(() => loadConfig({ ...base, AGENT_NAMES: 'Ok,TEST' }), /clashes/, 'untracked names too');
  assert.deepEqual(loadConfig({ ...base, AGENT_NAMES: 'Ok,Code', AGENTS: 'ask' }).agentNames, ['Ok', 'Code']);
  assert.equal(c.agentCooldownSeconds, 60);
  assert.equal(c.handoffWindowSeconds, 120);
  assert.equal(loadConfig({ ...base, AGENT_COOLDOWN_SECONDS: '0' }).agentCooldownSeconds, 0, '0 disables');
  assert.equal(loadConfig({ ...base, HANDOFF_WINDOW_SECONDS: '30' }).handoffWindowSeconds, 30);
  assert.throws(() => loadConfig({ ...base, AGENT_COOLDOWN_SECONDS: '-1' }), /AGENT_COOLDOWN_SECONDS/);
  assert.throws(() => loadConfig({ ...base, HANDOFF_WINDOW_SECONDS: 'x' }), /HANDOFF_WINDOW_SECONDS/);
});

test('retired names and unknown in AGENTS are dropped with a startup warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const c = loadConfig({
    INGEST_TOKEN: GOOD_A,
    DASHBOARD_TOKEN: GOOD_B,
    AGENTS: 'spec,test,code,security,styling,code-review,unknown,verify',
  });
  assert.deepEqual(c.agents, ['spec', 'code', 'verify']);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    String(warn.mock.calls[0].arguments[0]),
    /untracked agents \(test, security, styling, code-review, unknown\)/,
  );
});

test('redaction covers bearer, sk-, gh tokens, JWT, KEY=, password=, AWS keys, private keys', () => {
  const samples = [
    'curl -H "Authorization: Bearer abcdef1234567890xyz"',
    'key sk-abcdefghijklmnop1234',
    'ghp_abcdefghijklmnopqrstuv1234',
    'gho_abcdefghijklmnopqrstuv1234',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl',
    'API_KEY=hunter2hunter2',
    'MY_TOKEN=abc123',
    'password=correcthorse',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ];
  const secrets = [
    'abcdef1234567890xyz',
    'sk-abcdefghijklmnop1234',
    'ghp_abcdefghijklmnopqrstuv1234',
    'gho_abcdefghijklmnopqrstuv1234',
    'c2lnbmF0dXJl',
    'hunter2hunter2',
    'abc123',
    'correcthorse',
    'AKIAIOSFODNN7EXAMPLE',
    'MIIEow',
  ];
  samples.forEach((s, i) => {
    const out = redactString(s);
    assert.ok(out.includes(REDACTED), `no redaction in: ${s}`);
    assert.ok(!out.includes(secrets[i]), `secret leaked from: ${s} -> ${out}`);
  });
  assert.equal(redactString('npm test -- --grep auth'), 'npm test -- --grep auth');
});

test('meta is sanitized: sensitive keys, long strings, size cap', () => {
  const m = sanitizeMeta({
    password: 'x',
    api_token: 'y',
    note: 'a'.repeat(1000),
    nested: { deep: { deeper: { deepest: 1 } } },
  });
  assert.equal(m.password, REDACTED);
  assert.equal(m.api_token, REDACTED);
  assert.ok(m.note.length <= 200);
  const big = {};
  for (let i = 0; i < 30; i++) big['k' + i] = 'v'.repeat(190);
  const capped = sanitizeMeta(big);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 2048);
  assert.equal(capped._truncated, true);
});

test('validateEvent accepts a minimal event and normalizes fields', () => {
  const r = validateEvent(
    { ts: '2026-10-18T06:00:00Z', agent: 'new-agent', session_id: 's', type: 'status' },
    Date.parse('2026-10-18T07:00:00Z'),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.event.ts, Date.parse('2026-10-18T06:00:00Z'));
  assert.equal(r.event.agent, 'new-agent');
});

test('validateEvent rejects bad input', () => {
  const now = Date.now();
  const base = { ts: now, agent: 'a', session_id: 's', type: 'stop' };
  for (const bad of [
    null,
    [],
    { ...base, type: 'bogus' },
    { ...base, agent: '' },
    { ...base, agent: 'has space' },
    { ...base, session_id: 5 },
    { ...base, ts: 'nope' },
    { ...base, ts: now + 10 * 86400000 },
    { ...base, tokens_in: -1 },
    { ...base, cost_usd: 'x' },
    { ...base, meta: 'str' },
    { ...base, summary: 5 },
  ]) {
    assert.equal(validateEvent(bad, now).ok, false, JSON.stringify(bad));
  }
});

test('validateEvent truncates and redacts summary and drops raw tool payloads', () => {
  const r = validateEvent(
    {
      ts: Date.now(),
      agent: 'a',
      session_id: 's',
      type: 'tool_end',
      summary: 'Bash: export TOKEN=abc123 && ' + 'x'.repeat(500),
      tool_input: { command: 'cat secret' },
      tool_response: { stdout: 'file contents' },
      file_contents: 'zzz',
    },
    Date.now(),
  );
  assert.ok(r.ok);
  assert.ok(r.event.summary.length <= 200);
  assert.ok(!r.event.summary.includes('abc123'));
  for (const k of ['tool_input', 'tool_response', 'file_contents']) assert.ok(!(k in r.event));
});

test('redaction covers CLI password forms and long hex, but not git SHAs', () => {
  const { redactString } = require('../src/redact');
  for (const s of [
    'curl -u bob:hunter2 https://x.test',
    'mysql -u root -phunter2 db',
    'tool --password hunter2 run',
    'tool --token hunter2 run',
    'export FOO=hunter2',
    'key is ' + 'a1b2c3d4'.repeat(6),
  ]) {
    assert.ok(!redactString(s).includes('hunter2'), s);
    assert.ok(!redactString(s).includes('a1b2c3d4a1b2'), s);
    assert.match(redactString(s), /\[REDACTED\]/, s);
  }
  assert.equal(redactString('mkdir -p /tmp/x && ls -la'), 'mkdir -p /tmp/x && ls -la');
  const sha = 'd948a8db8437e9138de786326526532b3c3641b0';
  assert.equal(redactString(`commit ${sha}`), `commit ${sha}`);
});

test('cookieSecure defaults to true; startup warns on plain-HTTP non-loopback', () => {
  const { loadConfig, startupWarnings } = require('../src/config');
  const base = {
    INGEST_TOKEN: 'ingest-tok-9f8e7d6c5b4a3210zz',
    DASHBOARD_TOKEN: 'dash-tok-1a2b3c4d5e6f7089yy',
  };
  assert.equal(loadConfig(base).cookieSecure, true);
  const lan = loadConfig({ ...base, COOKIE_SECURE: 'false', HOST: '0.0.0.0' });
  assert.equal(lan.cookieSecure, false);
  assert.equal(startupWarnings(lan).length, 1);
  assert.equal(startupWarnings(loadConfig({ ...base, COOKIE_SECURE: 'false', HOST: '127.0.0.1' })).length, 0);
});

test('redaction stays fast on adversarial input (no superlinear regex backtracking)', () => {
  const N = 60000;
  const inputs = {
    dashes: ' --' + 'a-'.repeat(N / 2),
    token: ' --' + 'token'.repeat(N / 5),
    mysql: 'mysql '.repeat(N / 6),
    keydots: 'a-'.repeat(N / 2),
    dots: 'a.'.repeat(N / 2),
    flags: ' --x'.repeat(N / 4),
    begin: '-----BEGIN A'.repeat(N / 12),
    userflag: ' -u a'.repeat(N / 5),
    export: 'export a'.repeat(N / 8),
    hex: 'a'.repeat(N) + 'g',
    spaces: ' '.repeat(N),
    keyword: 'password'.repeat(N / 8),
  };
  for (const [name, s] of Object.entries(inputs)) {
    const t0 = process.hrtime.bigint();
    redactString(s);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)}ms`);
    const t1 = process.hrtime.bigint();
    sanitizeMeta({ a: s });
    const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.ok(ms2 < 100, `${name} meta: ${ms2.toFixed(1)}ms`);
  }
});

test('flag-value and mysql redaction still work with bounded patterns', () => {
  assert.ok(!redactString('run --password hunter2 now').includes('hunter2'));
  assert.ok(!redactString('run --db-api-key-file-token abc123xyz').includes('abc123xyz'));
  assert.ok(!redactString('mysql -u root -phunter2 db').includes('hunter2'));
  assert.ok(!redactString('my_long_service_api_key=abcdef123456').includes('abcdef123456'));
  assert.ok(!redactString('postgres://user:hunter2@host/db').includes('hunter2'));
});

test('pipeline summaries get a 400 char cap, other events stay at 200; secrets are redacted in both', () => {
  const mk = (type, summary, meta) =>
    validateEvent(
      { ts: Date.now(), agent: 'orchestrator', session_id: 's', type, summary, meta },
      Date.now(),
    );
  const long = 'y '.repeat(500);
  const p = mk('pipeline', long, { run_id: 'r', kind: 'question' });
  assert.ok(p.ok);
  assert.ok(p.event.summary.length > 200 && p.event.summary.length <= 400);
  assert.ok(mk('status', long).event.summary.length <= 200);
  const sec = mk('pipeline', 'deployed with TOKEN=abc123def456 ok', {
    run_id: 'r',
    kind: 'server_task',
    target: 'host password=hunter2',
  });
  assert.ok(!sec.event.summary.includes('abc123def456'));
  assert.ok(!sec.event.meta.target.includes('hunter2'));
  assert.equal(sec.event.meta.kind, 'server_task');
});

test('validateEvent accepts link events only with a valid run_id on a subagent session', () => {
  const now = Date.now();
  const base = {
    ts: now,
    agent: 'code',
    session_id: 'p1:a1',
    type: 'link',
    meta: { run_id: 'alpha-1000000001' },
  };
  const ok = validateEvent(
    { ...base, summary: 'x', tool_input: { prompt: 'secret' }, meta: { run_id: 'alpha-1-1b', extra: 'y' } },
    now,
  );
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.event.meta, { run_id: 'alpha-1-1b' }, 'only run_id is kept');
  assert.ok(validateEvent({ ...base, meta: { run_id: 'a'.repeat(80) } }, now).ok);
  for (const bad of [
    { ...base, meta: undefined },
    { ...base, meta: { run_id: '' } },
    { ...base, meta: { run_id: 'a'.repeat(81) } },
    { ...base, meta: { run_id: 'has space' } },
    { ...base, meta: { run_id: 'a:b' } },
    { ...base, meta: { run_id: 5 } },
    { ...base, session_id: 'p1' },
    { ...base, session_id: 'p1:' },
  ]) {
    assert.equal(validateEvent(bad, now).ok, false, JSON.stringify(bad));
  }
});
