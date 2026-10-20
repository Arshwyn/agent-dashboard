'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = () => import('../public/js/office/handoff.js');
const h = { from: 'Ada', to: 'Bram', at: 100000, inferred: true };

test('freshHandoff: a new inferred handoff walks once, old, seen or malformed ones do not', async () => {
  const { freshHandoff, handoffKey } = await mod();
  const seen = new Set();
  assert.equal(freshHandoff(h, seen, 102000), handoffKey(h));
  seen.add(handoffKey(h));
  assert.equal(freshHandoff(h, seen, 102000), null, 'already shown');
  assert.equal(freshHandoff(h, new Set(), 100000 + 11000), null, 'older than 10 s (a page reload)');
  assert.equal(freshHandoff({ ...h, inferred: false }, new Set(), 100000), null);
  assert.equal(freshHandoff(null, new Set(), 100000), null);
  assert.equal(freshHandoff({ from: 'Ada' }, new Set(), 100000), null);
  assert.equal(freshHandoff({ ...h, at: 'x' }, new Set(), 100000), null);
});

test('handoffText: receiver and giver read differently and both say inferred', async () => {
  const { handoffText } = await mod();
  assert.equal(handoffText(h, 'Bram'), 'from Ada (inferred handoff)');
  assert.equal(handoffText(h, 'Ada'), 'to Bram (inferred handoff)');
  assert.equal(handoffText(h, 'Carl'), '');
  assert.equal(handoffText(null, 'Ada'), '');
});
