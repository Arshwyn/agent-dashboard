'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectHandoff } = require('../src/handoff');

const W = 120 * 1000;
const stop = { person: 'Ada', role: 'spec', ts: 1000 };

test('a different person starting a different role inside the window is an inferred handoff', () => {
  assert.deepEqual(detectHandoff(stop, { person: 'Bram', role: 'code', ts: 1000 + 5000 }, W), {
    from: 'Ada',
    to: 'Bram',
    at: 6000,
    inferred: true,
  });
  assert.ok(detectHandoff(stop, { person: 'Bram', role: 'code', ts: 1000 }, W), 't2 = t counts');
  assert.ok(detectHandoff(stop, { person: 'Bram', role: 'code', ts: 1000 + W }, W), 'window edge counts');
});

test('no handoff outside the window, backwards in time, or without a previous stop', () => {
  assert.equal(detectHandoff(stop, { person: 'Bram', role: 'code', ts: 1000 + W + 1 }, W), null);
  assert.equal(detectHandoff(stop, { person: 'Bram', role: 'code', ts: 999 }, W), null);
  assert.equal(detectHandoff(null, { person: 'Bram', role: 'code', ts: 2000 }, W), null);
});

test('the same person (a role change) or the same role is not a handoff', () => {
  assert.equal(detectHandoff(stop, { person: 'Ada', role: 'code', ts: 2000 }, W), null);
  assert.equal(detectHandoff(stop, { person: 'Bram', role: 'spec', ts: 2000 }, W), null);
});
