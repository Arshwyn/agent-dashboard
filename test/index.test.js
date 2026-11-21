'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HUB_AGENTS } = require('../src/chat');

const sqliteOk = Number(process.versions.node.split('.')[0]) >= 22;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function boot(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'development',
      DEV_AUTH_BYPASS: '1',
      HOST: '127.0.0.1',
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const t0 = Date.now();
  while (!out.includes('listening') && child.exitCode === null && Date.now() - t0 < 8000)
    await new Promise((r) => setTimeout(r, 50));
  return {
    base: `http://127.0.0.1:${port}`,
    out: () => out,
    async stop() {
      if (child.exitCode === null) {
        const done = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await done;
      }
    },
  };
}

test(
  'the entry point wires the store and gateway client, and creates the history file private (0600)',
  { skip: !sqliteOk && 'needs Node 22+ for better-sqlite3' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-idx-'));
    const app = await boot({
      GATEWAY_SOCKET: path.join(dir, 'g.sock'),
      DB_PATH: path.join(dir, 'sub', 'hub.db'),
    });
    try {
      const st = await (await fetch(app.base + '/api/chat/status')).json();
      assert.equal(st.available, false, 'no gateway behind the socket yet');
      assert.deepEqual(st.agents, [...HUB_AGENTS]);
      const c = await fetch(app.base + '/api/chats', {
        method: 'POST',
        headers: {
          'X-Hub-Request': '1',
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agent: 'arshwyn' }),
      });
      assert.equal(c.status, 201);
      assert.equal(fs.statSync(path.join(dir, 'sub', 'hub.db')).mode & 0o777, 0o600);
    } finally {
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('without a gateway socket the shell runs, chat is offline and no database is created', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-idx-'));
  const app = await boot({ DB_PATH: path.join(dir, 'hub.db') });
  try {
    assert.equal((await fetch(app.base + '/api/chat/status')).status, 503);
    assert.equal((await fetch(app.base + '/api/roster')).status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'hub.db')), false);
  } finally {
    await app.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
