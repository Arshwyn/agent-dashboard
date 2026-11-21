'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, errorText, refusalNotice, rowText } = require('../public/js/streamstate');

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

test('every refused status gets a plain sentence, never an empty notice or a bare ellipsis', () => {
  const busy = 'Another reply is still running. Wait for it to finish or press Stop.';
  assert.equal(refusalNotice(409, { error: 'busy' }, null), busy);
  assert.equal(refusalNotice(409, null, null), busy);
  assert.equal(refusalNotice(409, { error: 'not_enabled' }, null), 'Chat is not enabled for this agent yet.');
  assert.equal(
    refusalNotice(429, { error: 'rate limited' }, '12'),
    'Too many messages. Wait 12 seconds and try again.',
  );
  assert.match(refusalNotice(429, null, null), /Wait a few seconds/);
  assert.equal(refusalNotice(503, { error: 'disabled' }, null), 'Web chat is switched off.');
  assert.match(refusalNotice(503, { error: 'unavailable' }, null), /not reachable/);
  assert.match(refusalNotice(503, null, null), /not reachable/);
  assert.equal(refusalNotice(413, { error: 'message too long' }, null), 'That message is too long.');
  assert.match(refusalNotice(401, null, null), /sign-in has expired/);
  assert.match(refusalNotice(403, { error: 'forbidden' }, null), /Reload the page/);
  assert.match(refusalNotice(404, null, null), /no longer exists/);
  assert.match(refusalNotice(500, null, null), /had an error/);
  assert.match(refusalNotice(502, null, null), /had an error/);
  assert.equal(refusalNotice(400, { error: 'bad request' }, null), 'The message was not accepted.');
  assert.equal(refusalNotice(418, undefined, undefined), 'The message was not accepted.');
  for (let st = 400; st < 600; st++) {
    for (const body of [null, {}, { error: 'x' }, { error: 5 }]) {
      const t = refusalNotice(st, body, 'zz');
      assert.ok(typeof t === 'string' && t.length > 10 && t.trim() !== '...', `${st}`);
    }
  }
});

test('a refused stream event becomes a notice, goes idle and keeps the log as it is', () => {
  for (const code of ['busy', 'disabled', 'not_enabled', 'too_large', 'unavailable']) {
    const s = create();
    s.apply('thinking', {});
    const e = s.apply('error', { code, refused: true });
    assert.equal(e.refused, true, code);
    assert.ok(e.notice && e.notice.length > 10, code);
    assert.equal(e.stage, 'idle');
    assert.equal(e.removeTool, true);
  }
  assert.match(
    create().apply('error', { code: 'busy', refused: true }).notice,
    /Another reply is still running/,
  );
  assert.equal(
    create().apply('error', { code: 'too_large', refused: true }).notice,
    'That message is too long.',
  );
  // a failure of a run that did start is not a refusal
  const f = create().apply('error', { code: 'failed' });
  assert.equal(f.refused, undefined);
  assert.equal(f.notice, undefined);
});

test('error texts: known codes, and an unknown or inherited code falls back to a generic line', () => {
  assert.equal(errorText('timeout'), 'The run took too long and was stopped.');
  assert.equal(errorText('nonsense'), 'The run failed. Try again.');
  assert.equal(errorText('constructor'), 'The run failed. Try again.');
  assert.equal(errorText(undefined), 'The run failed. Try again.');
});

test('a stored reply that is still running reads as in progress, not as an ellipsis', () => {
  assert.equal(rowText({ text: '', status: 'streaming' }), 'Reply in progress...');
  assert.equal(rowText({ text: 'part', status: 'streaming' }), 'part');
  assert.equal(rowText({ text: '', status: 'error' }), '');
  assert.equal(rowText({ text: 'hi', status: 'done' }), 'hi');
});

test('a failed run whose row could not be saved says so, and the stored fallback code reads as not saved', () => {
  const s = create();
  s.apply('delta', { text: 'kept text' });
  const e = s.apply('error', { code: 'failed', unsaved: true });
  assert.deepEqual(e.notes, ['This reply could not be saved to the history.']);
  assert.equal(s.keepLog(), true);
  assert.equal(errorText('unsaved'), 'This reply could not be saved to the history.');
});
