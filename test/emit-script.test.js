'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'emit-pipeline-event.sh');

// Run the script against a local capture server; resolves with the posted meta (or null).
async function emit(args) {
  let body = null;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      body = JSON.parse(b);
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const code = await new Promise((resolve) => {
    const p = spawn('bash', [SCRIPT, '--run-id', 'r1', '--state', 'active', ...args], {
      env: {
        PATH: process.env.PATH,
        AGENT_DASHBOARD_ENV_FILE: '/nonexistent',
        AGENT_DASHBOARD_URL: `http://127.0.0.1:${srv.address().port}`,
        AGENT_DASHBOARD_INGEST_TOKEN: 'test-token',
      },
      stdio: 'ignore',
    });
    p.on('close', resolve);
  });
  srv.close();
  return { code, meta: body && body.meta };
}

test('emit script: --substep is sent only for a valid name on verify or review', async () => {
  let r = await emit(['--step', 'verify', '--substep', 'test']);
  assert.equal(r.code, 0);
  assert.equal(r.meta.step, 'verify');
  assert.equal(r.meta.substep, 'test');
  r = await emit(['--step', 'review', '--substep', 'code-review']);
  assert.equal(r.meta.substep, 'code-review');
  for (const bad of [
    ['--step', 'verify', '--substep', 'security'],
    ['--step', 'verify', '--substep', 'bogus; rm -rf'],
    ['--step', 'code', '--substep', 'test'],
    ['--step', 'review', '--substep', 'test'],
    ['--substep', 'test'],
  ]) {
    r = await emit(bad);
    assert.equal(r.code, 0);
    assert.ok(!('substep' in r.meta), bad.join(' '));
  }
  r = await emit(['--step', 'test']);
  assert.equal(r.meta.step, 'test', 'legacy step names are still sent as given');
});

test('emit script: exits 0 with no server', async () => {
  const code = await new Promise((resolve) => {
    const p = spawn(
      'bash',
      [SCRIPT, '--run-id', 'r', '--step', 'verify', '--substep', 'test', '--state', 'active'],
      {
        env: {
          PATH: process.env.PATH,
          AGENT_DASHBOARD_ENV_FILE: '/nonexistent',
          AGENT_DASHBOARD_URL: 'http://127.0.0.1:9',
          AGENT_DASHBOARD_INGEST_TOKEN: 'x',
        },
        stdio: 'ignore',
      },
    );
    p.on('close', resolve);
  });
  assert.equal(code, 0);
});
