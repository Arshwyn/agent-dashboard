'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routePattern, isHealthCheck } = require('../src/requestLog');
const { createMemoryStore } = require('../src/store');
const { makeToken, startApp, CSRF } = require('./helpers');

const LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z [A-Z]+ \S+ \d{3} \d+ms \d+b$/;

test('paths are reduced to a fixed pattern; unknown paths are logged as (other)', () => {
  const cases = [
    ['/', '/'],
    ['/?token=abc', '/'],
    ['/agent/arshwyn', '/agent/:id'],
    ['/api/chats', '/api/chats'],
    ['/api/chats?agent=arshwyn', '/api/chats'],
    ['/api/chats/0b9f4f1e-6b1d-4c5e-8a55-2f3c9f6d1a77', '/api/chats/:id'],
    ['/api/chats/0b9f4f1e-6b1d-4c5e-8a55-2f3c9f6d1a77/messages?x=1', '/api/chats/:id/messages'],
    ['/api/chats/anything/stop', '/api/chats/:id/stop'],
    ['/api/chat/status', '/api/chat/status'],
    ['/js/app.js', '/js/:file'],
    ['/css/app.css', '/css/:file'],
    ['/models/a.glb', '/models/:file'],
    ['/secret-token-in-path', '(other)'],
    ['/api/chats/a/b/c', '(other)'],
    ['//evil.example/x', '(other)'],
    ['/a\\b', '(other)'],
    ['', '(other)'],
    [undefined, '(other)'],
  ];
  for (const [url, want] of cases) assert.equal(routePattern(url), want, String(url));
  assert.equal(isHealthCheck('/healthz'), true);
  assert.equal(isHealthCheck('/healthz?x=1'), true);
  assert.equal(isHealthCheck('/api/chats'), false);
});

test('a logged request carries only time, method, pattern, status, duration and bytes', async () => {
  const lines = [];
  const SECRET_Q = 'qs-secret-9981';
  const SECRET_BODY = 'body-secret-7742';
  const SECRET_COOKIE = 'cookie-secret-5513';
  const jwt = makeToken();
  const s = await startApp(
    {},
    { store: createMemoryStore(), gateway: null, requestLog: (l) => lines.push(l) },
  );
  try {
    await fetch(`${s.base}/healthz`);
    await fetch(`${s.base}/api/roster?token=${SECRET_Q}&jwt=${jwt}`, {
      headers: {
        'Cf-Access-Jwt-Assertion': jwt,
        Cookie: `CF_Authorization=${SECRET_COOKIE}`,
        'X-Real-IP': '203.0.113.9',
      },
    });
    await fetch(`${s.base}/api/chats`, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': jwt, ...CSRF },
      body: JSON.stringify({ agent: 'arshwyn', title: SECRET_BODY }),
    });
    await fetch(`${s.base}/some/${SECRET_Q}/path?x=${SECRET_Q}`); // no auth: 401, unknown path
    await fetch(`${s.base}/api/roster`); // no auth
    assert.equal(lines.length, 4, 'the health check is not logged');
    for (const l of lines) {
      assert.match(l, LINE);
      for (const bad of [
        SECRET_Q,
        SECRET_BODY,
        SECRET_COOKIE,
        jwt,
        '203.0.113.9',
        'token',
        'jwt',
        '127.0.0.1',
        '?',
      ]) {
        assert.ok(!l.includes(bad), `${bad} must not appear in: ${l}`);
      }
    }
    const [roster, create, unknown, noauth] = lines.map((l) => l.split(' '));
    assert.deepEqual([roster[1], roster[2], roster[3]], ['GET', '/api/roster', '200']);
    assert.deepEqual([create[1], create[2], create[3]], ['POST', '/api/chats', '201']);
    assert.deepEqual([unknown[2], unknown[3]], ['(other)', '401']);
    assert.deepEqual([noauth[2], noauth[3]], ['/api/roster', '401']);
    assert.ok(Number(roster[5].slice(0, -1)) > 50, 'the response size is counted');
  } finally {
    await s.stop();
  }
});

test('a streamed response is counted and logged once it ends; ids never appear', async () => {
  const lines = [];
  const store = createMemoryStore();
  const gateway = {
    async status() {
      return { enabled: true, busy: false, agents: ['arshwyn'] };
    },
    async cancel() {
      return true;
    },
    async run(_r, { onLine }) {
      onLine(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        }),
      );
      return { type: 'exit', code: 0 };
    },
  };
  const s = await startApp({}, { store, gateway, requestLog: (l) => lines.push(l) });
  try {
    const h = { 'Cf-Access-Jwt-Assertion': makeToken(), ...CSRF };
    const c = (
      await (
        await fetch(`${s.base}/api/chats`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ agent: 'arshwyn' }),
        })
      ).json()
    ).conversation;
    const r = await fetch(`${s.base}/api/chats/${c.id}/messages`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ text: 'prompt-secret-3321' }),
    });
    const text = await r.text();
    for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((x) => setTimeout(x, 10));
    const l = lines.find((x) => x.includes('/messages'));
    assert.match(l, LINE);
    assert.ok(l.includes(' POST /api/chats/:id/messages 200 '));
    assert.ok(!l.includes(c.id) && !l.includes('prompt-secret-3321'));
    assert.equal(Number(l.split(' ')[5].slice(0, -1)), Buffer.byteLength(text));
  } finally {
    await s.stop();
  }
});
