'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');

const INGEST = 'ingest-tok-9f8e7d6c5b4a3210zz';
const DASH = 'dash-tok-1a2b3c4d5e6f7089yy';

function makeConfig(extra = {}) {
  return { ...loadConfig({ INGEST_TOKEN: INGEST, DASHBOARD_TOKEN: DASH, DB_PATH: ':memory:' }), ...extra };
}

async function startApp(extra = {}, opts = {}) {
  const config = makeConfig(extra);
  const store = openDb(':memory:');
  const app = createApp(config, store, opts);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    store,
    config,
    base,
    async stop() {
      await app.close();
      store.close();
    },
  };
}

function ev(over = {}) {
  return { ts: Date.now(), agent: 'code', session_id: 's1', type: 'tool_start', tool: 'Bash', ...over };
}

function post(base, body, token = INGEST) {
  return fetch(`${base}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const authed = (token = DASH) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Open an SSE stream and collect parsed messages. */
function openSse(base, headers = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const waiters = [];
    const hdrs = { Authorization: `Bearer ${DASH}`, ...headers };
    for (const k of Object.keys(hdrs)) if (hdrs[k] === null) delete hdrs[k];
    const req = http.get(`${base}/api/stream`, { headers: hdrs }, (res) => {
      let buf = '';
      const ended = new Promise((r) => res.on('close', r));
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = { raw: block };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) m.event = line.slice(7);
            else if (line.startsWith('data: ')) m.data = JSON.parse(line.slice(6));
            else if (line.startsWith('id: ')) m.id = line.slice(4);
          }
          messages.push(m);
          waiters.slice().forEach((w) => w());
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        messages,
        ended,
        close: () => req.destroy(),
        waitFor(pred, ms = 3000) {
          return new Promise((ok, no) => {
            const t = setTimeout(() => no(new Error('SSE wait timeout')), ms);
            const check = () => {
              const f = messages.find(pred);
              if (f) {
                clearTimeout(t);
                waiters.splice(waiters.indexOf(check), 1);
                ok(f);
              }
            };
            waiters.push(check);
            check();
          });
        },
      });
    });
    req.on('error', reject);
  });
}

// Temp dirs created through tempDir(); swept on exit as a backstop.
const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Creates an `ad-` temp dir under os.tmpdir() and removes it when the test ends, even on failure.
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  tempDirs.add(dir);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  });
  return dir;
}

module.exports = { tempDir, startApp, ev, post, authed, openSse, INGEST, DASH, makeConfig };
