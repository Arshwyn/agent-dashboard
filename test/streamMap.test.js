'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamMapper, toolLabel } = require('../src/streamMap');

const ev = (o) => JSON.stringify(o);
const delta = (text) =>
  ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

test('text deltas, the session init and the result map to the safe event set', () => {
  const m = createStreamMapper();
  assert.deepEqual(m.push(ev({ type: 'system', subtype: 'init', session_id: 's', tools: ['Bash'] })), [
    { kind: 'session' },
  ]);
  assert.deepEqual(m.push(delta('Hi ')), [{ kind: 'delta', text: 'Hi ' }]);
  assert.deepEqual(m.push(delta('there')), [{ kind: 'delta', text: 'there' }]);
  assert.deepEqual(
    m.push(ev({ type: 'result', is_error: false, result: 'Hi there', usage: { input_tokens: 1 } })),
    [{ kind: 'result', isError: false, text: 'Hi there' }],
  );
  assert.equal(m.finalText(), 'Hi there');
});

test('a tool call turns the text before it into interim narration and yields only a generic label', () => {
  const m = createStreamMapper();
  m.push(delta('Let me look.'));
  const out = m.push(
    ev({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'a', name: 'Read' } },
    }),
  );
  assert.deepEqual(out, [
    { kind: 'interim', text: 'Let me look.' },
    { kind: 'tool', label: 'reading' },
  ]);
  // the same tool seen again in the assistant message is not repeated
  assert.deepEqual(
    m.push(
      ev({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/secret' } }] },
      }),
    ),
    [],
  );
  m.push(delta('Done.'));
  assert.equal(m.finalText(), 'Done.');
});

test('tool inputs, tool results, thinking and unknown events never come out', () => {
  const m = createStreamMapper();
  const all = [
    ev({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'cat /etc/secret' } }],
      },
    }),
    ev({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'SECRET-OUTPUT' }] },
    }),
    ev({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'SECRET-THOUGHT' } },
    }),
    ev({ type: 'rate_limit_event', info: 'x' }),
    'not json',
    ev(null),
    ev('str'),
  ].flatMap((l) => m.push(l));
  assert.deepEqual(all, [{ kind: 'tool', label: 'running a command' }]);
  assert.ok(!JSON.stringify(all).includes('SECRET'));
});

test('labels are generic categories, never tool names with arguments', () => {
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'using a connector');
  assert.equal(toolLabel('WebFetch'), 'searching the web');
  assert.equal(toolLabel('Edit'), 'writing');
  assert.equal(toolLabel('Whatever'), 'working');
  assert.equal(toolLabel(undefined), 'working');
});

test('an error result is flagged', () => {
  const m = createStreamMapper();
  assert.deepEqual(m.push(ev({ type: 'result', is_error: true, result: 'x' })), [
    { kind: 'result', isError: true, text: 'x' },
  ]);
});

test('server and connector tool blocks count as tool events too', () => {
  for (const type of ['tool_use', 'server_tool_use', 'mcp_tool_use']) {
    const m = createStreamMapper();
    const out = m.push(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: type, id: 'x1', name: 'anything' } },
      }),
    );
    assert.equal(out.filter((e) => e.kind === 'tool').length, 1, type);
    const m2 = createStreamMapper();
    const out2 = m2.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: type, id: 'x2', name: 'n', input: { a: 1 } }] },
      }),
    );
    assert.equal(out2.filter((e) => e.kind === 'tool').length, 1, type);
  }
});
