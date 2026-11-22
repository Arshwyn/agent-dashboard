'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { accept, STATES } = require('../public/js/apollostate');

const ORIGIN = 'https://chat.example.com';
const FRAME = { name: 'frame' };
const ev = (data, over = {}) => ({ data, origin: ORIGIN, source: FRAME, ...over });

test('the two fixed shapes are accepted from the exact origin and the frame window', () => {
  assert.deepEqual(accept(ev({ type: 'apollo-ready' }), ORIGIN, FRAME), { kind: 'ready' });
  for (const state of STATES) {
    assert.deepEqual(accept(ev({ type: 'apollo-state', state }), ORIGIN, FRAME), { kind: 'state', state });
  }
  assert.deepEqual(STATES, ['idle', 'thinking', 'speaking']);
});

test('a spoofed origin, another window or a missing expectation is ignored', () => {
  const good = { type: 'apollo-state', state: 'speaking' };
  assert.equal(accept(ev(good, { origin: 'https://evil.example.com' }), ORIGIN, FRAME), null);
  assert.equal(accept(ev(good, { origin: ORIGIN + '.evil.example.com' }), ORIGIN, FRAME), null);
  assert.equal(accept(ev(good, { origin: 'http://chat.example.com' }), ORIGIN, FRAME), null);
  assert.equal(accept(ev(good, { source: { name: 'other' } }), ORIGIN, FRAME), null);
  assert.equal(accept(ev(good, { source: null }), ORIGIN, FRAME), null);
  assert.equal(accept(ev(good), ORIGIN, null), null);
  assert.equal(accept(ev(good), ORIGIN, undefined), null);
  assert.equal(accept(ev(good), '', FRAME), null);
  assert.equal(accept(ev(good), '*', FRAME), null);
  assert.equal(accept(ev(good, { origin: '*' }), '*', FRAME), null);
  assert.equal(accept(null, ORIGIN, FRAME), null);
});

test('wrong shapes, extra fields, other states and non-objects are ignored', () => {
  const bad = [
    'apollo-ready',
    42,
    null,
    undefined,
    [],
    ['apollo-ready'],
    {},
    { type: 'apollo-ready', text: 'hello' },
    { type: 'apollo-ready', extra: undefined },
    { type: 'apollo-state' },
    { type: 'apollo-state', state: 'busy' },
    { type: 'apollo-state', state: 'IDLE' },
    { type: 'apollo-state', state: ['idle'] },
    { type: 'apollo-state', state: 'idle', text: 'x' },
    { type: 'apollo-state', state: { toString: () => 'idle' } },
    { type: 'apollo-other', state: 'idle' },
    { type: 'x'.repeat(100000) },
    { state: 'idle' },
  ];
  for (const d of bad) assert.equal(accept(ev(d), ORIGIN, FRAME), null, JSON.stringify(d)?.slice(0, 60));
  class Fake {
    constructor() {
      this.type = 'apollo-ready';
    }
  }
  assert.equal(accept(ev(new Fake()), ORIGIN, FRAME), null);
});

test('the page keeps Apollo messages in memory only: no storage, no network, nothing sent to the frame', () => {
  const root = path.join(__dirname, '..', 'public', 'js');
  const state = fs.readFileSync(path.join(root, 'apollostate.js'), 'utf8');
  assert.equal(
    /fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|postMessage|console\./.test(state),
    false,
  );
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const start = app.indexOf('// ---------- Apollo in a frame');
  const end = app.indexOf('function drawBlocked(');
  const block = app.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal(
    /fetch\(|api\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|postMessage|console\.|innerHTML/.test(
      block,
    ),
    false,
  );
  assert.match(block, /sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals'/);
  assert.match(block, /referrerpolicy: 'no-referrer'/);
  assert.equal(/allow-top-navigation|allow-popups/.test(block), false);
  assert.equal((block.match(/el\('iframe'/g) || []).length, 1, 'one frame, created in one place');
  assert.equal(/iframe/i.test(app.replace(block, '')), false, 'no other iframe anywhere in the app code');
  assert.equal(/src: a\.link,/.test(block), true, 'the frame address is the configured link only');
});

test('the shell loads the message filter before the app', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(
    html.indexOf('/js/apollostate.js') > 0 && html.indexOf('/js/apollostate.js') < html.indexOf('/js/app.js'),
  );
});
