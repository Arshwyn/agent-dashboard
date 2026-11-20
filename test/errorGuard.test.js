'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createErrorGuard } = require('../src/errorGuard');

function make(over = {}) {
  const g = { t: 0, exits: [], logs: [] };
  g.guard = createErrorGuard({
    now: () => g.t,
    exit: (c) => g.exits.push(c),
    log: (...a) => g.logs.push(a.join(' ')),
    ...over,
  });
  return g;
}

test('a few errors are logged by name and tolerated', () => {
  const g = make();
  for (let i = 0; i < 5; i++) g.guard('uncaught error', new TypeError('SECRET-DETAIL'));
  assert.deepEqual(g.exits, []);
  assert.ok(g.logs.every((l) => !l.includes('SECRET')));
  assert.ok(g.logs[0].includes('TypeError'));
});

test('more than five errors inside a minute exit non-zero', () => {
  const g = make();
  for (let i = 0; i < 6; i++) {
    g.t += 1000;
    g.guard('unhandled rejection', new Error('x'));
  }
  assert.deepEqual(g.exits, [1]);
});

test('errors spread over time do not trip the guard', () => {
  const g = make();
  for (let i = 0; i < 20; i++) {
    g.t += 20_000;
    g.guard('uncaught error', new Error('x'));
  }
  assert.deepEqual(g.exits, []);
});
