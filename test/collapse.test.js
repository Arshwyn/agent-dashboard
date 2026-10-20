'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = () => import('../public/js/collapse.js');

test('parseStored trusts only the exact open and closed strings', async () => {
  const { parseStored } = await mod();
  assert.equal(parseStored('open', false), true);
  assert.equal(parseStored('closed', true), false);
  for (const bad of [null, undefined, '', 'OPEN', 'true', '1', {}]) {
    assert.equal(parseStored(bad, true), true);
    assert.equal(parseStored(bad, false), false);
  }
});

test('readOpen and writeOpen use one key per section and survive throwing storage', async () => {
  const { readOpen, writeOpen, KEY_PREFIX } = await mod();
  assert.equal(KEY_PREFIX, 'agent-dashboard.section.');
  const data = new Map();
  const ok = () => ({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) });
  writeOpen(ok, 'costs', true);
  assert.equal(data.get('agent-dashboard.section.costs'), 'open');
  writeOpen(ok, 'costs', false);
  assert.equal(readOpen(ok, 'costs', true), false);
  assert.equal(readOpen(ok, 'sessions', false), false);
  const boom = () => {
    throw new Error('blocked');
  };
  assert.equal(readOpen(boom, 'costs', true), true);
  assert.doesNotThrow(() => writeOpen(boom, 'costs', true));
});
