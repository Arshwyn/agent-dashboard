'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/js/streamstate');

test('deltas accumulate, the first one starts speaking, done returns to idle', () => {
  const s = create();
  assert.equal(s.apply('thinking', {}).stage, 'thinking');
  const a = s.apply('delta', { text: 'Hel' });
  assert.equal(a.stage, 'speaking');
  assert.equal(s.apply('delta', { text: 'lo' }).liveText, 'Hello');
  const d = s.apply('done', { text: 'Hello' });
  assert.deepEqual([d.stage, d.liveText, d.announce, d.notes], ['idle', 'Hello', 'complete', []]);
  assert.equal(s.keepLog(), false);
});

test('an unsaved reply keeps its text, shows the note and tells the page not to reload the log', () => {
  const s = create();
  s.apply('delta', { text: 'Reply text' });
  const d = s.apply('done', { text: 'Reply text', unsaved: true });
  assert.equal(d.liveText, 'Reply text');
  assert.deepEqual(d.notes, ['This reply could not be saved to the history.']);
  assert.equal(s.keepLog(), true);
});

test('interim narration becomes a note and resets the live text; tool events show a label', () => {
  const s = create();
  s.apply('delta', { text: 'Let me look.' });
  const i = s.apply('interim', { text: ' Let me look. ' });
  assert.deepEqual([i.interim, i.liveText, i.stage], ['Let me look.', '', 'thinking']);
  assert.equal(s.apply('tool', { label: 'reading' }).tool, 'reading...');
  assert.equal(s.apply('delta', { text: 'Done' }).stage, 'speaking');
});

test('stopped and error events', () => {
  const s = create();
  s.apply('delta', { text: 'part' });
  const d = s.apply('done', { text: 'part', cancelled: true });
  assert.deepEqual([d.notes, d.announce, s.keepLog()], [['Stopped.'], 'stopped', false]);
  const e = create().apply('error', { code: 'timeout' });
  assert.deepEqual([e.stage, e.errorCode, e.removeTool], ['error', 'timeout', true]);
});
