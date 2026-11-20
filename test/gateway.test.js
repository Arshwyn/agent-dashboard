'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  PROFILES,
  loadGatewayConfig,
  validateRun,
  buildArgv,
  buildEnv,
  createGateway,
} = require('../gateway/gateway');
const { createGatewayClient, GatewayError } = require('../src/gatewayClient');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const CONV = '0b9f4f1e-6b1d-4c5e-8a55-2f3c9f6d1a77';
const RUN = 'run_aaaaaaaa11';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkEnv(over = {}) {
  const dataDir = tmp('gw-data-');
  const workspaceDir = tmp('gw-ws-');
  return { GATEWAY_DATA_DIR: dataDir, WORKSPACE_DIR: workspaceDir, CLAUDE_BIN: FAKE, ...over };
}

function cleanup(env) {
  for (const k of ['GATEWAY_DATA_DIR', 'WORKSPACE_DIR']) fs.rmSync(env[k], { recursive: true, force: true });
}

async function startGateway(over = {}) {
  const env = mkEnv(over);
  const home = tmp('gw-home-');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const cfg = loadGatewayConfig(env);
  const gw = createGateway(cfg, { log: () => {} });
  await gw.listen();
  const client = createGatewayClient({ socketPath: cfg.socketPath, backoffMs: [] });
  return {
    cfg,
    gw,
    client,
    home,
    argvLog: () =>
      fs.existsSync(path.join(home, 'argv.jsonl'))
        ? fs
            .readFileSync(path.join(home, 'argv.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
        : [],
    audit: () =>
      fs.existsSync(cfg.auditLog)
        ? fs
            .readFileSync(cfg.auditLog, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
        : [],
    async stop() {
      await gw.close();
      process.env.HOME = prevHome;
      cleanup(env);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const req = (over = {}) => ({
  agent: 'arshwyn',
  conversation_id: CONV,
  resume: false,
  prompt: 'hi',
  run_id: RUN,
  ...over,
});

test('only the pilot is enabled; apollo is not in the table at all', () => {
  const enabled = Object.keys(PROFILES).filter((k) => PROFILES[k].enabled);
  assert.deepEqual(enabled, ['arshwyn']);
  assert.ok(!Object.hasOwn(PROFILES, 'apollo'));
  assert.ok(
    Object.isFrozen(PROFILES) &&
      Object.isFrozen(PROFILES.arshwyn) &&
      Object.isFrozen(PROFILES.arshwyn.settingSources),
  );
});

test('validation rejects unknown agents, apollo, other agents, bad ids, bad types and extra fields', () => {
  const code = (r) => {
    try {
      validateRun(r);
      return 'ok';
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(code(req()), 'ok');
  assert.equal(code(req({ agent: 'apollo' })), 'not_proxied');
  assert.equal(code(req({ agent: 'nobody' })), 'not_proxied');
  assert.equal(code(req({ agent: '__proto__' })), 'invalid');
  assert.equal(code(req({ agent: 'constructor' })), 'not_proxied');
  for (const a of ['hephaestus', 'themis', 'janus', 'atlas', 'plutus', 'iris', 'dionysus']) {
    assert.equal(code(req({ agent: a })), 'not_enabled', a);
  }
  assert.equal(code(req({ conversation_id: 'not-a-uuid' })), 'invalid');
  assert.equal(code(req({ conversation_id: CONV.toUpperCase() })), 'invalid');
  assert.equal(code(req({ resume: 'yes' })), 'invalid');
  assert.equal(code(req({ run_id: 'x' })), 'invalid');
  assert.equal(code(req({ prompt: '   ' })), 'invalid');
  assert.equal(code(req({ prompt: 5 })), 'invalid');
  assert.equal(code(req({ prompt: 'x'.repeat(16001) })), 'too_large');
  assert.equal(code(req({ prompt: 'a\0b' })), 'too_large');
  for (const extra of ['model', 'cwd', 'args', 'env', 'tools', 'permission_mode', 'flags']) {
    assert.equal(code({ ...req(), [extra]: 'x' }), 'invalid', extra);
  }
  assert.equal(code(null), 'invalid');
  assert.equal(code([]), 'invalid');
  assert.equal(code('x'), 'invalid');
});

test('argv comes from the fixed profile; only the session uuid and the resume choice vary', () => {
  const cfg = { model: null };
  const first = buildArgv(cfg, validateRun(req()));
  const again = buildArgv(cfg, validateRun(req({ resume: true })));
  assert.deepEqual(first.slice(0, -2), again.slice(0, -2));
  assert.deepEqual(first.slice(-2), ['--session-id', CONV]);
  assert.deepEqual(again.slice(-2), ['--resume', CONV]);
  assert.ok(!first.includes('--agent'), 'the pilot is the main session, not an --agent');
  for (const banned of [
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--allowedTools',
    '--allowed-tools',
    '--add-dir',
    '--mcp-config',
    '--permission-mode=bypassPermissions',
  ]) {
    assert.ok(!first.includes(banned), banned);
  }
  assert.equal(first[first.indexOf('--permission-mode') + 1], 'default');
  assert.equal(first[first.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(!first.some((a) => /bypass/i.test(a)));
  // the prompt never reaches the argv
  assert.ok(!first.join(' ').includes('hi'));
  assert.deepEqual(buildArgv({ model: 'sonnet' }, validateRun(req())).slice(-4, -2), ['--model', 'sonnet']);
});

test('the documented profile matches the argv exactly', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ISOLATION.md'), 'utf8');
  const block = /<!-- profile:arshwyn:begin -->\n([\s\S]*?)<!-- profile:arshwyn:end -->/.exec(doc);
  assert.ok(block, 'docs/ISOLATION.md has the profile block');
  const documented = block[1]
    .trim()
    .split('\n')
    .flatMap((l) => (l.startsWith('--session-id|') ? [] : l.split(/ (.+)/).filter(Boolean)));
  const actual = buildArgv({ model: null }, validateRun(req())).slice(0, -2);
  const flat = documented.flatMap((l) => (/^--?[a-z-]+$/.test(l) || !l.includes(' ') ? [l] : [l]));
  assert.deepEqual(flat, actual, 'ISOLATION.md lists exactly the flags the gateway passes');
});

test('the child environment is minimal and carries no gateway secrets', () => {
  const env = buildEnv({}, RUN, {
    PATH: '/bin',
    HOME: '/h',
    LANG: 'C',
    SECRET_TOKEN: 'x',
    ANTHROPIC_API_KEY: 'k',
    ACCESS_AUD: 'a',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HUB_CHAT_RUN', 'HUB_RUN_ID', 'LANG', 'PATH']);
});

test('config requires absolute paths and a sane model name', () => {
  const env = mkEnv();
  try {
    assert.throws(() => loadGatewayConfig({ ...env, WORKSPACE_DIR: 'relative' }), /WORKSPACE_DIR/);
    assert.throws(() => loadGatewayConfig({ ...env, GATEWAY_DATA_DIR: '' }), /GATEWAY_DATA_DIR/);
    assert.throws(() => loadGatewayConfig({ ...env, GATEWAY_MODEL: 'a b; rm' }), /GATEWAY_MODEL/);
    assert.throws(
      () => loadGatewayConfig({ ...env, GATEWAY_SOCKET: '/tmp/' + 'x'.repeat(120) + '.sock' }),
      /too long/,
    );
    assert.throws(() => loadGatewayConfig({ ...env, RUN_TIMEOUT_MS: '0' }), /RUN_TIMEOUT_MS/);
    assert.equal(loadGatewayConfig(env).runTimeoutMs, 600000);
  } finally {
    cleanup(env);
  }
});

test('a run streams the fake claude, in the workspace, with the fixed flags and a 0600 socket', async () => {
  const g = await startGateway();
  try {
    assert.equal(fs.statSync(g.cfg.socketPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(g.cfg.dataDir).mode & 0o777, 0o700);
    const lines = [];
    const exit = await g.client.run(req({ prompt: 'echo please' }), { onLine: (l) => lines.push(l) });
    assert.equal(exit.code, 0);
    assert.equal(exit.cancelled, false);
    assert.ok(lines.some((l) => l.includes('"text_delta"')));
    const [call] = g.argvLog();
    assert.equal(call.stdin, 'echo please');
    assert.equal(fs.realpathSync(call.cwd), g.cfg.workspaceDir);
    assert.deepEqual(call.argv.slice(-2), ['--session-id', CONV]);
    assert.deepEqual(
      call.envKeys.filter(
        (k) =>
          !['HOME', 'LANG', 'PATH', 'HUB_CHAT_RUN', 'HUB_RUN_ID', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(k),
      ),
      [],
    );
    const again = await g.client.run(req({ resume: true, run_id: 'run_bbbbbbbb22' }), {});
    assert.equal(again.code, 0);
    assert.deepEqual(g.argvLog()[1].argv.slice(-2), ['--resume', CONV]);
  } finally {
    await g.stop();
  }
});

test('requests with bad fields get a generic error and never start a process', async () => {
  const g = await startGateway();
  try {
    await assert.rejects(
      g.client.run(req({ agent: 'apollo' })),
      (e) => e instanceof GatewayError && e.code === 'not_proxied',
    );
    await assert.rejects(g.client.run(req({ agent: 'themis' })), (e) => e.code === 'not_enabled');
    await assert.rejects(g.client.run({ ...req(), cwd: '/' }), (e) => e.code === 'invalid');
    await assert.rejects(g.client.run(req({ prompt: 'x'.repeat(20000) })), (e) => e.code === 'too_large');
    assert.equal(g.argvLog().length, 0);
  } finally {
    await g.stop();
  }
});

test('the kill switch (env or file) stops new runs and shows in status, checked on every request', async () => {
  const g = await startGateway();
  try {
    assert.equal((await g.client.status()).enabled, true);
    fs.writeFileSync(g.cfg.killSwitchFile, '');
    assert.equal((await g.client.status()).enabled, false);
    await assert.rejects(g.client.run(req()), (e) => e.code === 'disabled');
    fs.rmSync(g.cfg.killSwitchFile);
    assert.equal((await g.client.status()).enabled, true);
    assert.equal((await g.client.run(req())).code, 0);
  } finally {
    await g.stop();
  }
  const g2 = await startGateway({ GATEWAY_DISABLED: '1' });
  try {
    await assert.rejects(g2.client.run(req()), (e) => e.code === 'disabled');
    assert.equal((await g2.client.status()).enabled, false);
  } finally {
    await g2.stop();
  }
});

test('only one run at a time: the second is refused as busy, and the first can be cancelled', async () => {
  const g = await startGateway();
  try {
    const lines = [];
    const first = g.client.run(req({ prompt: 'slow' }), { onLine: (l) => lines.push(l) });
    const t0 = Date.now();
    while (!lines.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.length, 'the first run is streaming');
    assert.equal((await g.client.status()).busy, true);
    await assert.rejects(
      g.client.run(
        req({ run_id: 'run_cccccccc33', conversation_id: '11111111-1111-4111-8111-111111111111' }),
      ),
      (e) => e.code === 'busy',
    );
    assert.equal(await g.client.cancel('does-not-exist'), false);
    assert.equal(await g.client.cancel(RUN), true);
    const exit = await first;
    assert.equal(exit.cancelled, true);
    assert.ok(exit.code === 130 || exit.signal);
    assert.equal((await g.client.status()).busy, false);
  } finally {
    await g.stop();
  }
});

test('a client that disappears mid-run ends the run and frees the slot', async () => {
  const g = await startGateway();
  try {
    const c = net.createConnection(g.cfg.socketPath);
    await new Promise((r) => c.once('connect', r));
    let got = '';
    c.setEncoding('utf8');
    c.on('data', (d) => (got += d));
    c.write(JSON.stringify(req({ prompt: 'slow' })) + '\n');
    const t0 = Date.now();
    while (!got.includes('"line"') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await g.client.status()).busy, true);
    c.destroy();
    const t1 = Date.now();
    while ((await g.client.status()).busy && Date.now() - t1 < 5000)
      await new Promise((r) => setTimeout(r, 30));
    assert.equal((await g.client.status()).busy, false);
    const last = g
      .audit()
      .filter((a) => a.event === 'run')
      .pop();
    assert.equal(last.cancelled, true);
  } finally {
    await g.stop();
  }
});

test('the kill switch ends a run that is already in progress, and frees the slot', async () => {
  const g = await startGateway({ KILL_POLL_MS: '100', KILL_GRACE_MS: '500' });
  try {
    const lines = [];
    const first = g.client.run(req({ prompt: 'slow' }), { onLine: (l) => lines.push(l) });
    const t0 = Date.now();
    while (!lines.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.length, 'the run is streaming');
    fs.writeFileSync(g.cfg.killSwitchFile, '');
    const t1 = Date.now();
    const exit = await first;
    assert.ok(Date.now() - t1 < 3000, 'ended within a bound');
    assert.equal(exit.switchedOff, true);
    assert.equal((await g.client.status()).busy, false);
    assert.equal(
      g
        .audit()
        .filter((a) => a.event === 'run')
        .pop().switched_off,
      true,
    );
  } finally {
    await g.stop();
  }
});

/** Dead means gone or a zombie (an unreaped child, as in a container without an init, still answers kill -0). */
function isDead(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ESRCH') {
      try {
        process.kill(pid, 0); // no /proc: kill -0 semantics
      } catch {
        return true;
      }
      return false;
    }
    return true;
  }
}

async function waitDead(pid, ms = 3000) {
  const t0 = Date.now();
  while (!isDead(pid) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 40));
  return isDead(pid);
}

test('a background child left behind by a finished run is swept with its group', async () => {
  const g = await startGateway();
  try {
    const exit = await g.client.run(req({ prompt: 'stray' }));
    assert.equal(exit.code, 0);
    const pid = Number(fs.readFileSync(path.join(g.home, 'stray.pid'), 'utf8'));
    assert.equal(await waitDead(pid), true);
  } finally {
    await g.stop();
  }
});

test('a stray process outside the group that holds the pipe open cannot hold the slot or fake a timeout', async () => {
  const g = await startGateway({ EXIT_GRACE_MS: '300', RUN_TIMEOUT_MS: '1500' });
  let pid = 0;
  try {
    const t0 = Date.now();
    const exit = await g.client.run(req({ prompt: 'escape' }));
    pid = Number(fs.readFileSync(path.join(g.home, 'escape.pid'), 'utf8'));
    assert.ok(Date.now() - t0 < 1400, 'finished by the exit grace, not by the run timeout');
    assert.equal(exit.code, 0);
    assert.equal(exit.timedOut, false);
    assert.equal((await g.client.status()).busy, false);
    const run = g
      .audit()
      .filter((a) => a.event === 'run')
      .pop();
    assert.equal(run.timedOut, false);
    await new Promise((r) => setTimeout(r, 1500)); // past the run timeout: still not reported as one
    assert.equal(g.audit().filter((a) => a.event === 'run').length, 1);
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL'); // the sleeper this test started (pid written by the fake)
      } catch {
        // gone
      }
    }
    await g.stop();
  }
});

test('a run that already ended is never reported as switched off', async () => {
  const g = await startGateway({ KILL_POLL_MS: '50', EXIT_GRACE_MS: '1200' });
  let pid = 0;
  try {
    // the sleeper keeps the pipe open for the exit grace; the kill switch is set in that window
    const p = g.client.run(req({ prompt: 'escape' }));
    const t0 = Date.now();
    while (!fs.existsSync(path.join(g.home, 'escape.pid')) && Date.now() - t0 < 3000)
      await new Promise((r) => setTimeout(r, 20));
    pid = Number(fs.readFileSync(path.join(g.home, 'escape.pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(g.cfg.killSwitchFile, '');
    const exit = await p;
    assert.equal(exit.switchedOff, false);
    assert.equal(
      g
        .audit()
        .filter((a) => a.event === 'run')
        .pop().switched_off,
      false,
    );
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    await g.stop();
  }
});

test('a cancel after the run has exited sends no signal and is refused', async () => {
  const g = await startGateway();
  try {
    await g.client.run(req());
    assert.equal(await g.client.cancel(RUN), false);
  } finally {
    await g.stop();
  }
});

test('a run past the timeout is killed even if it ignores signals, and the exit says so', async () => {
  const g = await startGateway({ RUN_TIMEOUT_MS: '300', KILL_GRACE_MS: '200' });
  try {
    const exit = await g.client.run(req({ prompt: 'stubborn' }));
    assert.equal(exit.timedOut, true);
    assert.equal(exit.signal, 'SIGKILL');
  } finally {
    await g.stop();
  }
});

test('output over the cap stops the run and is flagged', async () => {
  const g = await startGateway({ MAX_OUT_BYTES: '200000' });
  try {
    const exit = await g.client.run(req({ prompt: 'big' }));
    assert.equal(exit.tooBig, true);
    assert.ok(exit.outBytes >= 200000);
  } finally {
    await g.stop();
  }
});

test('the audit log records metadata only: no prompt, reply or tool input', async () => {
  const g = await startGateway();
  try {
    await g.client.run(req({ prompt: 'tool PROMPT-SECRET-TEXT' }));
    await g.client.run(req({ prompt: 'fail PROMPT-SECRET-TEXT', run_id: 'run_dddddddd44' }));
    await assert.rejects(g.client.run(req({ agent: 'apollo', prompt: 'PROMPT-SECRET-TEXT' })));
    const raw = fs.readFileSync(g.cfg.auditLog, 'utf8');
    for (const secret of [
      'PROMPT-SECRET-TEXT',
      'TOOL-OUTPUT-SECRET',
      '/secret/path.txt',
      'SECRET-DETAIL',
      'All done',
      'Hello',
    ]) {
      assert.ok(!raw.includes(secret), secret);
    }
    assert.equal(fs.statSync(g.cfg.auditLog).mode & 0o777, 0o600);
    const rows = g.audit();
    const runs = rows.filter((r) => r.event === 'run');
    assert.equal(runs.length, 2);
    assert.deepEqual(
      Object.keys(runs[0]).sort(),
      [
        'agent',
        'cancelled',
        'code',
        'conversation_id',
        'ms',
        'out_bytes',
        'prompt_chars',
        'resume',
        'run_id',
        'signal',
        't',
        'timedOut',
        'tokens_in',
        'tokens_out',
        'tooBig',
        'switched_off',
        'event',
      ].sort(),
    );
    assert.equal(runs[0].tokens_in, 11);
    assert.equal(runs[0].tokens_out, 7);
    assert.equal(runs[1].code, 1);
    assert.ok(rows.some((r) => r.event === 'rejected' && r.code === 'not_proxied'));
  } finally {
    await g.stop();
  }
});

test('raw socket garbage is rejected without a crash', async () => {
  const g = await startGateway();
  try {
    const talk = (payload) =>
      new Promise((resolve) => {
        const c = net.connect(g.cfg.socketPath, () => c.write(payload));
        let d = '';
        c.on('data', (x) => (d += x));
        c.on('close', () => resolve(d));
      });
    assert.match(await talk('not json\n'), /"invalid"/);
    assert.match(await talk(JSON.stringify({ op: 'status', x: 1 }) + '\n'), /"invalid"|"type":"error"/);
    assert.match(await talk('x'.repeat(70000)), /too_large/);
    assert.match(await talk(JSON.stringify({ cancel: 5 }) + '\n'), /"invalid"/);
    assert.equal((await g.client.status()).enabled, true);
  } finally {
    await g.stop();
  }
});
