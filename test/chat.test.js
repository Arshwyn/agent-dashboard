'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore } = require('../src/store');
const { GatewayError, createGatewayClient } = require('../src/gatewayClient');
const { loadGatewayConfig, createGateway } = require('../gateway/gateway');
const { makeToken, startApp, CSRF } = require('./helpers');

const H = () => ({ 'Cf-Access-Jwt-Assertion': makeToken(), ...CSRF });
const line = (o) => JSON.stringify(o);
const delta = (text) =>
  line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const init = line({ type: 'system', subtype: 'init' });
const result = (text, isError = false) => line({ type: 'result', is_error: isError, result: text });

function fakeGateway(over = {}) {
  const g = {
    calls: [],
    cancels: [],
    state: { enabled: true, busy: false },
    release: null,
    async status() {
      return { type: 'status', enabled: g.state.enabled, busy: g.state.busy, agents: ['arshwyn'] };
    },
    async cancel(id) {
      g.cancels.push(id);
      if (g.release) g.release();
      return true;
    },
    async run(req, { onLine }) {
      g.calls.push(req);
      return (
        over.run ||
        (async () => {
          onLine(init);
          onLine(delta('Hello '));
          onLine(delta('there'));
          onLine(result('Hello there'));
          return { type: 'exit', code: 0, cancelled: false, timedOut: false };
        })
      )(req, onLine, g);
    },
  };
  return g;
}

async function app(gw, env = {}, store = createMemoryStore()) {
  const s = await startApp(env, { store, gateway: gw });
  return { ...s, store };
}

async function api(s, method, p, body, headers = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: { ...H(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, json, text, headers: r.headers };
}

function sse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((b) => {
      const ev = /event: (.+)/.exec(b)[1];
      const data = JSON.parse(/data: (.+)/.exec(b)[1]);
      return [ev, data];
    });
}

async function newChat(s) {
  return (await api(s, 'POST', '/api/chats', { agent: 'arshwyn' })).json.conversation;
}

test('conversations: create, list, read, rename, delete; only the pilot is accepted', async () => {
  const s = await app(fakeGateway());
  try {
    const c = await newChat(s);
    assert.equal(c.agent, 'arshwyn');
    assert.equal(c.title, 'New chat');
    assert.equal((await api(s, 'POST', '/api/chats', { agent: 'apollo' })).status, 409);
    assert.equal((await api(s, 'POST', '/api/chats', { agent: 'themis' })).status, 409);
    assert.equal((await api(s, 'POST', '/api/chats', { agent: 'arshwyn', extra: 1 })).status, 400);
    assert.equal((await api(s, 'POST', '/api/chats', null)).status, 400);
    const list = await api(s, 'GET', '/api/chats?agent=arshwyn');
    assert.equal(list.json.conversations.length, 1);
    assert.equal((await api(s, 'GET', '/api/chats?agent=apollo')).json.conversations.length, 0);
    assert.equal((await api(s, 'GET', `/api/chats/${c.id}`)).json.messages.length, 0);
    assert.equal(
      (await api(s, 'PATCH', `/api/chats/${c.id}`, { title: 'Renamed' })).json.conversation.title,
      'Renamed',
    );
    assert.equal((await api(s, 'PATCH', `/api/chats/${c.id}`, { title: '  ' })).status, 400);
    assert.equal((await api(s, 'PATCH', `/api/chats/${c.id}`, { title: 'x', agent: 'themis' })).status, 400);
    assert.equal((await api(s, 'DELETE', `/api/chats/${c.id}`)).status, 200);
    assert.equal((await api(s, 'GET', `/api/chats/${c.id}`)).status, 404);
    assert.equal((await api(s, 'GET', '/api/chats/not-a-uuid')).status, 404);
    assert.equal((await api(s, 'DELETE', `/api/chats/${c.id}`)).status, 404);
  } finally {
    await s.stop();
  }
});

test('sending streams start, thinking, deltas and done, stores the reply and maps the session', async () => {
  const gw = fakeGateway();
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'Hi Arshwyn' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const events = sse(r.text);
    assert.deepEqual(
      events.map((e) => e[0]),
      ['start', 'thinking', 'delta', 'delta', 'done'],
    );
    assert.equal(events[4][1].text, 'Hello there');
    assert.deepEqual(gw.calls[0], {
      agent: 'arshwyn',
      conversation_id: c.id,
      resume: false,
      prompt: 'Hi Arshwyn',
      run_id: gw.calls[0].run_id,
    });
    assert.match(gw.calls[0].run_id, /^[A-Za-z0-9_-]{8,64}$/);
    const conv = (await api(s, 'GET', `/api/chats/${c.id}`)).json;
    assert.deepEqual(
      conv.messages.map((m) => [m.role, m.text, m.status]),
      [
        ['user', 'Hi Arshwyn', 'done'],
        ['assistant', 'Hello there', 'done'],
      ],
    );
    assert.equal(conv.conversation.title, 'Hi Arshwyn', 'the first message names the chat');
    // the second message resumes the same session
    await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'again' });
    assert.equal(gw.calls[1].resume, true);
    assert.equal(gw.calls[1].conversation_id, c.id);
  } finally {
    await s.stop();
  }
});

test('tool use becomes a generic label and interim text; inputs and outputs never reach the browser', async () => {
  const gw = fakeGateway({
    async run(_r, onLine) {
      onLine(init);
      onLine(delta('Checking.'));
      onLine(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'cat /secret' } }],
          },
        }),
      );
      onLine(
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'TOP-SECRET-OUTPUT' }] },
        }),
      );
      onLine(delta('Finished.'));
      onLine(result('Finished.'));
      return { type: 'exit', code: 0 };
    },
  });
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'go' });
    assert.ok(!r.text.includes('TOP-SECRET') && !r.text.includes('/secret') && !r.text.includes('cat '));
    const names = sse(r.text).map((e) => e[0]);
    assert.deepEqual(names, ['start', 'thinking', 'delta', 'interim', 'tool', 'delta', 'done']);
    assert.equal(sse(r.text).find((e) => e[0] === 'tool')[1].label, 'running a command');
    const stored = (await api(s, 'GET', `/api/chats/${c.id}`)).json.messages[1];
    assert.equal(stored.text, 'Finished.');
  } finally {
    await s.stop();
  }
});

test('failures become generic error codes and keep the partial text', async () => {
  const cases = [
    [async () => ({ type: 'exit', code: 1 }), 'failed'],
    [async () => ({ type: 'exit', code: 0, timedOut: true }), 'timeout'],
    [async () => ({ type: 'exit', code: 0, tooBig: true }), 'too_large'],
    [
      async () => {
        throw new GatewayError('disabled');
      },
      'disabled',
    ],
    [
      async () => {
        throw new GatewayError('busy');
      },
      'busy',
    ],
    [
      async () => {
        throw new GatewayError('closed');
      },
      'unavailable',
    ],
    [
      async () => {
        throw new Error('SECRET internals');
      },
      'unavailable',
    ],
  ];
  for (const [run, code] of cases) {
    const s = await app(fakeGateway({ run }));
    try {
      const c = await newChat(s);
      const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'x' });
      const err = sse(r.text).find((e) => e[0] === 'error');
      assert.equal(err[1].code, code);
      assert.ok(!r.text.includes('SECRET'));
      assert.equal((await api(s, 'GET', `/api/chats/${c.id}`)).json.messages[1].status, 'error');
    } finally {
      await s.stop();
    }
  }
  const s = await app(
    fakeGateway({
      async run(_r, onLine) {
        onLine(init);
        onLine(delta('partial'));
        onLine(result('boom', true));
        return { type: 'exit', code: 1 };
      },
    }),
  );
  try {
    const c = await newChat(s);
    await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'x' });
    const m = (await api(s, 'GET', `/api/chats/${c.id}`)).json.messages[1];
    assert.deepEqual([m.status, m.error_code, m.text], ['error', 'failed', 'partial']);
  } finally {
    await s.stop();
  }
});

test('input validation: shape, size, empty, NUL and unknown conversations', async () => {
  const gw = fakeGateway();
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const url = `/api/chats/${c.id}/messages`;
    assert.equal((await api(s, 'POST', url, { text: '' })).status, 400);
    assert.equal((await api(s, 'POST', url, { text: '   ' })).status, 400);
    assert.equal((await api(s, 'POST', url, { text: 5 })).status, 400);
    assert.equal((await api(s, 'POST', url, { text: 'a\0b' })).status, 400);
    assert.equal((await api(s, 'POST', url, { text: 'x', agent: 'apollo' })).status, 400);
    assert.equal((await api(s, 'POST', url, { text: 'x', cwd: '/' })).status, 400);
    assert.equal((await api(s, 'POST', url, { text: 'x'.repeat(8001) })).status, 413);
    assert.equal((await api(s, 'POST', url, { text: 'x'.repeat(30000) })).status, 413);
    assert.equal(
      (await api(s, 'POST', '/api/chats/0b9f4f1e-6b1d-4c5e-8a55-2f3c9f6d1a77/messages', { text: 'x' }))
        .status,
      404,
    );
    const bad = await fetch(s.base + url, {
      method: 'POST',
      headers: { ...H(), 'Content-Type': 'text/plain' },
      body: 'x',
    });
    assert.equal(bad.status, 415);
    const junk = await fetch(s.base + url, { method: 'POST', headers: H(), body: '{nope' });
    assert.equal(junk.status, 400);
    assert.equal(gw.calls.length, 0, 'nothing reached the gateway');
  } finally {
    await s.stop();
  }
});

test('a conversation of an agent that is not enabled cannot send', async () => {
  const gw = fakeGateway();
  const s = await app(gw);
  try {
    const other = s.store.createConversation('themis', 'x');
    assert.equal((await api(s, 'POST', `/api/chats/${other.id}/messages`, { text: 'hi' })).status, 409);
    assert.equal(gw.calls.length, 0);
  } finally {
    await s.stop();
  }
});

test('one run at a time: the second send is 409 while the first streams; stop cancels it', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const gw = fakeGateway({
    async run(_r, onLine, g) {
      onLine(init);
      onLine(delta('working'));
      g.release = release;
      await gate;
      return { type: 'exit', code: 143, cancelled: true };
    },
  });
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const first = api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'long' });
    for (let i = 0; i < 100 && gw.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'second' })).status, 409);
    const c2 = await newChat(s);
    assert.equal((await api(s, 'POST', `/api/chats/${c2.id}/messages`, { text: 'other chat' })).status, 409);
    assert.equal(
      (await api(s, 'DELETE', `/api/chats/${c.id}`)).status,
      409,
      'a running chat cannot be deleted',
    );
    assert.equal((await api(s, 'POST', `/api/chats/${c2.id}/stop`)).status, 404);
    assert.equal((await api(s, 'POST', `/api/chats/${c.id}/stop`)).status, 202);
    const r = await first;
    assert.deepEqual(
      sse(r.text).map((e) => e[0]),
      ['start', 'thinking', 'delta', 'done'],
    );
    assert.equal(sse(r.text)[3][1].cancelled, true);
    const m = (await api(s, 'GET', `/api/chats/${c.id}`)).json.messages[1];
    assert.deepEqual([m.status, m.text], ['cancelled', 'working']);
    assert.equal(gw.cancels.length, 1);
    assert.equal((await api(s, 'DELETE', `/api/chats/${c.id}`)).status, 200);
  } finally {
    await s.stop();
  }
});

test('a silent stretch keeps the stream open with comment lines the client ignores', async () => {
  const gw = fakeGateway({
    async run(_r, onLine) {
      onLine(init);
      await new Promise((r) => setTimeout(r, 250));
      onLine(delta('late'));
      onLine(result('late'));
      return { type: 'exit', code: 0, cancelled: false, timedOut: false };
    },
  });
  const s = await startApp({}, { store: createMemoryStore(), gateway: gw, keepaliveMs: 50 });
  try {
    const c = await newChat({ ...s, store: null });
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'wait' });
    assert.ok((r.text.match(/^: keepalive$/gm) || []).length >= 2);
    assert.ok(r.text.includes('event: done'));
  } finally {
    await s.stop();
  }
});

const okRun = async (_r, onLine) => {
  onLine(init);
  onLine(delta('fine'));
  onLine(result('fine'));
  return { type: 'exit', code: 0, cancelled: false, timedOut: false };
};
const failRun = async (_r, onLine) => {
  onLine(init);
  onLine(result('boom', true));
  return { type: 'exit', code: 1, cancelled: false, timedOut: false };
};

test('the session flag is set only after a successful run, never on the init event', async () => {
  const gw = fakeGateway({ run: failRun });
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'hi' });
    assert.equal(sse(r.text).pop()[0], 'error');
    assert.equal(s.store.getConversation(c.id).session_started, false);
  } finally {
    await s.stop();
  }
});

test('a failed resume is retried once with a fresh session, and the hub history is kept', async () => {
  const modes = [];
  const gw = fakeGateway({
    async run(r, onLine, g) {
      modes.push(r.resume);
      return (r.resume ? failRun : okRun)(r, onLine, g);
    },
  });
  const s = await app(gw);
  try {
    const c = await newChat(s);
    s.store.markSessionStarted(c.id);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'again' });
    assert.deepEqual(modes, [true, false]);
    assert.equal(sse(r.text).pop()[0], 'done');
    assert.equal(s.store.getConversation(c.id).session_started, true);
    assert.equal(s.store.listMessages(c.id).length, 2);
    assert.notEqual(gw.calls[0].run_id, gw.calls[1].run_id);
    assert.equal(s.app.chat.running.size, 0);
  } finally {
    await s.stop();
  }
});

test('a first run that died after the session was created is retried by resuming it', async () => {
  const modes = [];
  const gw = fakeGateway({
    async run(r, onLine, g) {
      modes.push(r.resume);
      return (r.resume ? okRun : failRun)(r, onLine, g);
    },
  });
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'hi' });
    assert.deepEqual(modes, [false, true]);
    assert.equal(sse(r.text).pop()[0], 'done');
  } finally {
    await s.stop();
  }
});

test('one failed write after a successful run is retried and the reply is saved normally', async () => {
  const st = createMemoryStore();
  const real = st.updateMessage;
  let n = 0;
  st.updateMessage = (...a) => {
    if (n++ === 0) throw new Error('busy');
    return real(...a);
  };
  const s = await app(fakeGateway({ run: okRun }), {}, st);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'hi' });
    const last = sse(r.text).pop();
    assert.equal(last[0], 'done');
    assert.equal(last[1].unsaved, undefined);
    assert.equal(st.listMessages(c.id)[1].text, 'fine');
  } finally {
    await s.stop();
  }
});

test('a run that used a tool and then failed is never retried (no repeated side effects)', async () => {
  const toolThenFail = async (_r, onLine) => {
    onLine(init);
    onLine(
      line({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } },
      }),
    );
    onLine(result('boom', true));
    return { type: 'exit', code: 1, cancelled: false, timedOut: false };
  };
  for (const resumeFirst of [true, false]) {
    const gw = fakeGateway({ run: toolThenFail });
    const s = await app(gw);
    try {
      const c = await newChat(s);
      if (resumeFirst) s.store.markSessionStarted(c.id);
      const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'deploy it' });
      assert.equal(gw.calls.length, 1, 'exactly one run');
      assert.equal(sse(r.text).pop()[0], 'error');
      assert.equal(s.store.listMessages(c.id).length, 2, 'history kept');
      assert.equal(s.store.getConversation(c.id).session_started, resumeFirst);
    } finally {
      await s.stop();
    }
  }
});

test('a cancelled, timed-out or switched-off run is not retried', async () => {
  for (const exit of [
    { code: 143, cancelled: true },
    { code: 143, timedOut: true },
    { code: 143, switchedOff: true },
  ]) {
    const gw = fakeGateway({
      async run(_r, onLine) {
        onLine(init);
        return { type: 'exit', cancelled: false, timedOut: false, ...exit };
      },
    });
    const s = await app(gw);
    try {
      const c = await newChat(s);
      const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'hi' });
      assert.equal(gw.calls.length, 1, JSON.stringify(exit));
      if (exit.switchedOff)
        assert.deepEqual(sse(r.text).pop(), ['error', { code: 'switched_off', message_id: 2 }]);
    } finally {
      await s.stop();
    }
  }
});

test('stop answers 409 when the gateway had nothing to cancel', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const gw = fakeGateway({
    async run(_r, onLine) {
      onLine(init);
      await gate;
      return { type: 'exit', code: 0, cancelled: false, timedOut: false };
    },
  });
  gw.cancel = async () => false;
  const s = await app(gw);
  try {
    const c = await newChat(s);
    const first = api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'x' });
    for (let i = 0; i < 100 && gw.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await api(s, 'POST', `/api/chats/${c.id}/stop`)).status, 409);
    release();
    await first;
  } finally {
    await s.stop();
  }
});

function throwingStore(which) {
  const st = createMemoryStore();
  const real = st[which];
  st.armed = true;
  st[which] = (...a) => {
    if (st.armed) throw new Error('disk full SECRET-DETAIL');
    return real(...a);
  };
  return st;
}

test('a store failure becomes a generic 500, never leaks detail and never leaves the slot taken', async () => {
  const st = throwingStore('addMessage');
  const s = await app(fakeGateway({ run: okRun }), {}, st);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'hi' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal error' });
    assert.ok(!r.text.includes('SECRET'));
    assert.equal(s.app.chat.running.size, 0);
    st.armed = false;
    assert.equal(
      sse((await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'again' })).text).pop()[0],
      'done',
    );
  } finally {
    await s.stop();
  }
});

test('a store failure after the run finished keeps the reply (marked unsaved), releases the slot and ends the stream', async () => {
  const st = createMemoryStore();
  const real = st.updateMessage;
  let armed = true;
  st.updateMessage = (...a) => {
    if (armed) throw new Error('disk full');
    return real(...a);
  };
  const s = await app(fakeGateway({ run: okRun }), {}, st);
  try {
    const c = await newChat(s);
    const r = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'hi' });
    assert.equal(r.status, 200);
    const last = sse(r.text).pop();
    assert.equal(last[0], 'done', 'the reply is delivered, not dropped');
    assert.equal(last[1].text, 'fine');
    assert.equal(last[1].unsaved, true);
    assert.equal(s.app.chat.running.size, 0);
    armed = false;
    assert.equal(
      sse((await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'again' })).text).pop()[0],
      'done',
    );
  } finally {
    await s.stop();
  }
});

test('an exception in a body callback is a generic 500 and the process keeps serving', async () => {
  const st = throwingStore('createConversation');
  const s = await app(fakeGateway({ run: okRun }), {}, st);
  try {
    const r = await api(s, 'POST', '/api/chats', { agent: 'arshwyn' });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal error' });
    assert.equal((await api(s, 'GET', '/api/chat/status')).status, 200);
  } finally {
    await s.stop();
  }
});

test('the per-minute message limit answers 429 with Retry-After', async () => {
  let t = Date.now();
  const s = await startApp(
    { CHAT_MAX_PER_MIN: '2' },
    { store: createMemoryStore(), gateway: fakeGateway(), now: () => t },
  );
  try {
    const c = await newChat(s);
    const send = () => api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'x' });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    t += 61_000;
    assert.equal((await send()).status, 200);
  } finally {
    await s.stop();
  }
});

test('the app-side kill switch refuses sends and shows in the status', async () => {
  const gw = fakeGateway();
  const s = await app(gw, { CHAT_DISABLED: '1' });
  try {
    const st = (await api(s, 'GET', '/api/chat/status')).json;
    assert.equal(st.enabled, false);
    assert.equal(st.disabled_by, 'app');
    const c = await newChat(s);
    assert.equal((await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'x' })).status, 503);
    assert.equal(gw.calls.length, 0);
  } finally {
    await s.stop();
  }
});

test('status reports the gateway kill switch, busy, offline and not-enabled agents', async () => {
  const gw = fakeGateway();
  const s = await app(gw);
  try {
    let st = (await api(s, 'GET', '/api/chat/status')).json;
    assert.deepEqual([st.enabled, st.available, st.busy, st.agents], [true, true, false, ['arshwyn']]);
    gw.state.enabled = false;
    gw.state.busy = true;
    st = (await api(s, 'GET', '/api/chat/status')).json;
    assert.deepEqual([st.enabled, st.disabled_by, st.busy], [false, 'gateway', true]);
    gw.status = async () => {
      throw new GatewayError('unavailable');
    };
    st = (await api(s, 'GET', '/api/chat/status')).json;
    assert.deepEqual([st.available], [false]);
  } finally {
    await s.stop();
  }
  const noGw = await app(null);
  try {
    const st = (await api(noGw, 'GET', '/api/chat/status')).json;
    assert.equal(st.available, false);
    const c = await newChat(noGw);
    assert.equal((await api(noGw, 'POST', `/api/chats/${c.id}/messages`, { text: 'x' })).status, 503);
  } finally {
    await noGw.stop();
  }
});

test('CSRF: every state-changing chat request needs the header, a same-origin provenance and JSON', async () => {
  const s = await app(fakeGateway());
  try {
    const c = await newChat(s);
    const send = (headers) =>
      fetch(s.base + `/api/chats/${c.id}`, {
        method: 'PATCH',
        headers: { 'Cf-Access-Jwt-Assertion': makeToken(), ...headers },
        body: JSON.stringify({ title: 'x' }),
      });
    const base = { 'Content-Type': 'application/json' };
    assert.equal((await send({ ...base })).status, 403, 'no header, no provenance');
    assert.equal((await send({ ...base, 'X-Hub-Request': '1' })).status, 403, 'header only');
    assert.equal((await send({ ...base, 'Sec-Fetch-Site': 'same-origin' })).status, 403, 'provenance only');
    assert.equal((await send({ ...base, 'X-Hub-Request': '1', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send({ ...base, 'X-Hub-Request': '1', 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal(
      (await send({ ...base, 'X-Hub-Request': '1', Origin: 'https://evil.example.com' })).status,
      403,
    );
    assert.equal((await send({ ...base, 'X-Hub-Request': '1', Origin: 'null' })).status, 403);
    assert.equal(
      (await send({ ...base, 'X-Hub-Request': '0', 'Sec-Fetch-Site': 'same-origin' })).status,
      403,
    );
    const host = new URL(s.base).host;
    assert.equal(
      (await send({ ...base, 'X-Hub-Request': '1', Origin: `http://${host}` })).status,
      200,
      'an Origin naming this host passes',
    );
    assert.equal(
      (await send({ ...base, 'X-Hub-Request': '1', 'Sec-Fetch-Site': 'same-origin' })).status,
      200,
    );
    for (const [m, p] of [
      ['POST', '/api/chats'],
      ['DELETE', `/api/chats/${c.id}`],
      ['POST', `/api/chats/${c.id}/messages`],
      ['POST', `/api/chats/${c.id}/stop`],
    ]) {
      const r = await fetch(s.base + p, {
        method: m,
        headers: { 'Cf-Access-Jwt-Assertion': makeToken(), ...base },
        body: m === 'DELETE' ? undefined : '{}',
      });
      assert.equal(r.status, 403, `${m} ${p}`);
    }
    // reads need no CSRF header but do need Access
    assert.equal(
      (
        await fetch(s.base + '/api/chats?agent=arshwyn', {
          headers: { 'Cf-Access-Jwt-Assertion': makeToken() },
        })
      ).status,
      200,
    );
    assert.equal((await fetch(s.base + '/api/chats?agent=arshwyn')).status, 401);
    // the app sends no CORS headers
    const r = await fetch(s.base + '/api/chats?agent=arshwyn', {
      headers: { 'Cf-Access-Jwt-Assertion': makeToken(), Origin: 'https://evil.example.com' },
    });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.stop();
  }
});

test('the strict CSP is still sent on chat responses', async () => {
  const s = await app(fakeGateway());
  try {
    const r = await api(s, 'GET', '/api/chats?agent=arshwyn');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe/);
  } finally {
    await s.stop();
  }
});

test('end to end through the real gateway and the fake claude: history, session mapping, no secrets in the log', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-data-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const cfg = loadGatewayConfig({
    GATEWAY_DATA_DIR: dataDir,
    WORKSPACE_DIR: ws,
    CLAUDE_BIN: path.join(__dirname, 'fixtures', 'fake-claude.js'),
  });
  const gw = createGateway(cfg, { log: () => {} });
  await gw.listen();
  const s = await app(createGatewayClient({ socketPath: cfg.socketPath, backoffMs: [] }));
  try {
    const c = await newChat(s);
    const r1 = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'tool PROMPT-SECRET' });
    assert.equal(sse(r1.text).at(-1)[0], 'done');
    const r2 = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'echo again' });
    assert.equal(sse(r2.text).at(-1)[1].text, 'Hello world');
    const calls = fs
      .readFileSync(path.join(home, 'argv.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(calls[0].argv.slice(-2), ['--session-id', c.id]);
    assert.deepEqual(calls[1].argv.slice(-2), ['--resume', c.id]);
    assert.equal((await api(s, 'GET', `/api/chats/${c.id}`)).json.messages.length, 4);
    const audit = fs.readFileSync(cfg.auditLog, 'utf8');
    assert.ok(!audit.includes('PROMPT-SECRET'));
    assert.equal(audit.trim().split('\n').length, 2);
  } finally {
    await s.stop();
    await gw.close();
    process.env.HOME = prev;
    for (const d of [dataDir, ws, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('through the real gateway: a failure after a tool event is one run, a failure right after init is retried once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-data-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ws-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const cfg = loadGatewayConfig({
    GATEWAY_DATA_DIR: dataDir,
    WORKSPACE_DIR: ws,
    CLAUDE_BIN: path.join(__dirname, 'fixtures', 'fake-claude.js'),
  });
  const gw = createGateway(cfg, { log: () => {} });
  await gw.listen();
  const s = await app(createGatewayClient({ socketPath: cfg.socketPath, backoffMs: [] }));
  const runs = () =>
    fs.existsSync(cfg.auditLog)
      ? fs
          .readFileSync(cfg.auditLog, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .filter((a) => a.event === 'run').length
      : 0;
  try {
    const c = await newChat(s);
    const r1 = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'toolfail now' });
    assert.equal(sse(r1.text).at(-1)[0], 'error');
    assert.equal(runs(), 1, 'the audit shows a single run');
    const r2 = await api(s, 'POST', `/api/chats/${c.id}/messages`, { text: 'fail now' });
    assert.equal(sse(r2.text).at(-1)[0], 'error');
    assert.equal(runs(), 3, 'one more run, retried once');
    assert.equal((await api(s, 'GET', `/api/chats/${c.id}`)).json.messages.length, 4);
  } finally {
    await s.stop();
    await gw.close();
    process.env.HOME = prev;
    for (const d of [dataDir, ws, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});
