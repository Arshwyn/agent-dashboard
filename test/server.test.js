'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');
const { makeToken, startApp, get, other, CSRF } = require('./helpers');

const H = () => ({ 'Cf-Access-Jwt-Assertion': makeToken() });

test('/healthz is open and /event is a 204 stub that stores nothing', async () => {
  const s = await startApp();
  try {
    const h = await get(s.base, '/healthz');
    assert.equal(h.status, 200);
    assert.equal(h.text, 'ok');
    const e = await fetch(`${s.base}/event`, {
      method: 'POST',
      headers: { Authorization: 'Bearer anything', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tool_start' }),
    });
    assert.equal(e.status, 204);
    assert.equal((await e.text()).length, 0);
    assert.equal((await get(s.base, '/event')).status, 405);
  } finally {
    await s.stop();
  }
});

test('everything else needs a valid Access token: 401 without, 403 for another identity', async () => {
  const s = await startApp();
  try {
    for (const p of ['/', '/api/roster', '/api/me', '/js/hub.js', '/models/atlas.glb', '/agent/atlas']) {
      assert.equal((await get(s.base, p)).status, 401, p);
    }
    // every chat route, with every method, is behind Access too (auth comes before CSRF and routing)
    const id = '0b9f4f1e-6b1d-4c5e-8a55-2f3c9f6d1a77';
    for (const p of [
      '/api/chat/status',
      '/api/chats',
      `/api/chats/${id}`,
      `/api/chats/${id}/messages`,
      `/api/chats/${id}/stop`,
    ]) {
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        const r = await fetch(s.base + p, {
          method,
          headers: {
            'X-Hub-Request': '1',
            'Sec-Fetch-Site': 'same-origin',
            'Content-Type': 'application/json',
          },
          body: method === 'GET' ? undefined : '{}',
        });
        assert.equal(r.status, 401, `${method} ${p}`);
      }
    }
    assert.equal((await get(s.base, '/api/roster', { 'Cf-Access-Jwt-Assertion': 'junk' })).status, 401);
    const wrong = { 'Cf-Access-Jwt-Assertion': makeToken({ email: 'other@example.com' }) };
    assert.equal((await get(s.base, '/api/roster', wrong)).status, 403);
    const forged = { 'Cf-Access-Jwt-Assertion': makeToken({}, { key: other.privateKey }) };
    assert.equal((await get(s.base, '/', forged)).status, 401);
    assert.equal((await get(s.base, '/', { Authorization: 'Bearer abc' })).status, 401);
  } finally {
    await s.stop();
  }
});

test('an unavailable key source fails closed with 503', async () => {
  const s = await startApp(
    {},
    {
      fetchJson: async () => {
        throw new Error('down');
      },
    },
  );
  try {
    assert.equal((await get(s.base, '/api/roster', H())).status, 503);
    assert.equal((await get(s.base, '/healthz')).status, 200, 'health stays open');
  } finally {
    await s.stop();
  }
});

test('the roster lists the nine agents (the pilot and the eight gods) in one data file, Mercury absent, Apollo as a link-out', async () => {
  const s = await startApp({ APOLLO_CHAT_URL: 'https://chat.example.com/' });
  try {
    const r = await get(s.base, '/api/roster', H());
    assert.equal(r.status, 200);
    const ids = r.json.agents.map((a) => a.id);
    assert.deepEqual(ids.sort(), [
      'apollo',
      'arshwyn',
      'atlas',
      'dionysus',
      'hephaestus',
      'iris',
      'janus',
      'plutus',
      'themis',
    ]);
    assert.ok(!ids.includes('mercury'));
    for (const a of r.json.agents) {
      if (a.id === 'arshwyn') continue; // the pilot has no generated figure yet; the viewer uses the procedural bust
      assert.ok(a.name && a.role && Array.isArray(a.palette) && a.palette.length === 3, a.id);
      assert.ok(a.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
      assert.ok(
        fs.existsSync(path.join(__dirname, '..', 'public', 'models', `${a.id}.glb`)),
        `${a.id} model`,
      );
    }
    for (const a of r.json.agents) {
      if (a.chat === 'hub') {
        assert.equal(typeof a.access, 'string', `${a.id} has an access note`);
        assert.ok(a.access.length > 10 && a.access.length <= 140, a.id);
        assert.ok(!/[/\\]|https?:|@/.test(a.access), `${a.id}: no paths, URLs or addresses`);
      } else assert.ok(!('access' in a), `${a.id} (link-out) has no access note`);
    }
    assert.equal(r.json.agents.find((a) => a.id === 'apollo').link, 'https://chat.example.com/');
    assert.equal(r.json.agents.find((a) => a.id === 'apollo').chat, 'link');
    assert.equal(r.json.agents.find((a) => a.id === 'atlas').link, null);
  } finally {
    await s.stop();
  }
});

test('without APOLLO_CHAT_URL the Apollo link is empty', async () => {
  const s = await startApp();
  try {
    const r = await get(s.base, '/api/roster', H());
    assert.equal(r.json.agents.find((a) => a.id === 'apollo').link, null);
  } finally {
    await s.stop();
  }
});

test('the shell, assets and per-agent routes are served with security headers', async () => {
  const s = await startApp();
  try {
    const idx = await get(s.base, '/', H());
    assert.equal(idx.status, 200);
    assert.match(idx.headers.get('content-type'), /text\/html/);
    assert.match(idx.text, /Agent hub/);
    assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await get(s.base, '/agent/apollo', H())).status, 200);
    assert.equal((await get(s.base, '/agent/mercury', H())).status, 404);
    const glb = await fetch(`${s.base}/models/atlas.glb`, { headers: H() });
    assert.equal(glb.status, 200);
    assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
    const etag = glb.headers.get('etag');
    await glb.arrayBuffer();
    const again = await fetch(`${s.base}/models/atlas.glb`, { headers: { ...H(), 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal((await get(s.base, '/vendor/three.min.js', H())).status, 200);
    assert.equal((await get(s.base, '/js/app.js', H())).status, 200);
    assert.equal((await get(s.base, '/css/app.css', H())).status, 200);
  } finally {
    await s.stop();
  }
});

test('non-GET methods, traversal and unknown paths are refused', async () => {
  const s = await startApp();
  try {
    const post = await fetch(`${s.base}/api/roster`, { method: 'POST', headers: { ...H(), ...CSRF } });
    assert.equal(post.status, 405);
    const noCsrf = await fetch(`${s.base}/api/roster`, { method: 'POST', headers: H() });
    assert.equal(noCsrf.status, 403);
    assert.equal((await get(s.base, '/api/nope', H())).status, 404);
    assert.equal((await get(s.base, '/..%2fpackage.json', H())).status, 404);
    assert.equal((await get(s.base, '/js/../../package.json', H())).status, 404);
    assert.equal((await get(s.base, '/src/server.js', H())).status, 404);
    assert.equal((await get(s.base, '/css/', H())).status, 404);
  } finally {
    await s.stop();
  }
});

test('the dev bypass serves loopback requests without a token and is announced by /api/me', async () => {
  const config = loadConfig({ DEV_AUTH_BYPASS: '1', NODE_ENV: 'development' });
  const app = createApp(config);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const me = await get(base, '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.email, 'dev@localhost.invalid');
    assert.equal((await get(base, '/api/roster')).status, 200);
    for (const h of [
      { 'X-Forwarded-For': '203.0.113.9' },
      { 'Cf-Connecting-Ip': '203.0.113.9' },
      { 'Cf-Ray': 'x' },
    ]) {
      assert.equal((await get(base, '/api/roster', h)).status, 403, Object.keys(h)[0]);
    }
  } finally {
    await app.close();
  }
});

test('the old dashboard is gone: no login, stream or data routes', async () => {
  const s = await startApp();
  try {
    for (const p of ['/login', '/api/stream', '/api/agents', '/api/pipeline', '/api/events', '/api/costs']) {
      const r = await get(s.base, p, H());
      assert.ok(r.status === 404, `${p} ${r.status}`);
    }
  } finally {
    await s.stop();
  }
});

test('odd request targets cannot be routed as another host, and auth still comes first', async () => {
  const s = await startApp();
  try {
    const raw = (target, headers = {}) =>
      new Promise((resolve) => {
        const net = require('node:net');
        const sock = net.connect(s.app.server.address().port, '127.0.0.1', () => {
          const h = Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join('');
          sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${h}Connection: close\r\n\r\n`);
        });
        let data = '';
        sock.on('data', (d) => (data += d));
        sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)[1])));
      });
    for (const t of ['//example.com/api/roster', '//api/roster', '/\\example.com/api/roster', '//healthz']) {
      assert.equal(await raw(t), 401, `${t} without a token`);
      assert.equal(await raw(t, { 'Cf-Access-Jwt-Assertion': makeToken() }), 400, `${t} with a token`);
    }
    assert.equal(await raw('/healthz'), 200);
  } finally {
    await s.stop();
  }
});

test('the hub CSP is byte-identical without the embed and gains one exact frame-src with it', async () => {
  const off = await startApp({ APOLLO_CHAT_URL: 'https://chat.example.com/app/' });
  let base;
  try {
    base = (await get(off.base, '/api/roster', H())).headers.get('content-security-policy');
    assert.equal(
      base,
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const a = (await get(off.base, '/api/roster', H())).json.agents.find((x) => x.id === 'apollo');
    assert.equal('embed' in a, false);
  } finally {
    await off.stop();
  }
  const on = await startApp({ APOLLO_CHAT_URL: 'https://chat.example.com/app/', APOLLO_EMBED: '1' });
  try {
    for (const p of ['/api/roster', '/', '/js/app.js', '/healthz']) {
      const r = await get(on.base, p, p === '/healthz' ? {} : H());
      const csp = r.headers.get('content-security-policy');
      assert.equal(
        csp,
        base.replace("connect-src 'self';", "connect-src 'self'; frame-src https://chat.example.com;"),
        p,
      );
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.match(csp, /frame-ancestors 'none'/, p);
      assert.doesNotMatch(csp, /\*/, p);
      assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', p);
    }
    const a = (await get(on.base, '/api/roster', H())).json.agents;
    assert.equal(a.find((x) => x.id === 'apollo').embed, true);
    assert.equal(a.find((x) => x.id === 'apollo').link, 'https://chat.example.com/app/');
    assert.ok(a.filter((x) => x.id !== 'apollo').every((x) => !('embed' in x)));
  } finally {
    await on.stop();
  }
});
