#!/usr/bin/env node
'use strict';
// A stand-in for the `claude` binary: no model, no network. It checks the flags the gateway must pass, records what
// it was started with into $HOME/argv.jsonl, and plays a scripted stream-json session chosen by the prompt text.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const need = [
  '-p',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  '--permission-prompts',
  '--setting-sources',
  '--max-turns',
];
const bad = need.filter((f) => !argv.includes(f));
const val = (f) => argv[argv.indexOf(f) + 1];
if (bad.length || val('--output-format') !== 'stream-json') {
  process.stderr.write('fake-claude: bad flags\n');
  process.exit(2);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  try {
    fs.appendFileSync(
      path.join(process.env.HOME || '.', 'argv.jsonl'),
      JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), stdin }) + '\n',
    );
  } catch {
    // ignore
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const sid = val('--session-id') || val('--resume');
  const delta = (text) =>
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
  const init = () =>
    out({ type: 'system', subtype: 'init', session_id: sid, tools: ['Read'], model: 'fake' });
  const result = (text, extra = {}) =>
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sid,
      usage: { input_tokens: 11, output_tokens: 7 },
      ...extra,
    });
  const p = stdin.trim();
  if (p.startsWith('slow')) {
    init();
    delta('working');
    process.on('SIGINT', () => process.exit(130));
    process.on('SIGTERM', () => process.exit(143));
    setTimeout(() => process.exit(0), 60000);
  } else if (p.startsWith('stubborn')) {
    init();
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 60000);
  } else if (p.startsWith('big')) {
    init();
    const chunk = 'x'.repeat(100000);
    for (let i = 0; i < 50; i++) delta(chunk);
    result('big');
  } else if (p.startsWith('fail')) {
    init();
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom SECRET-DETAIL',
      session_id: sid,
    });
    process.exit(1);
  } else if (p.startsWith('tool')) {
    init();
    delta('Let me look.');
    out({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read' } },
    });
    out({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/secret/path.txt' } }],
      },
    });
    out({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL-OUTPUT-SECRET' }] },
    });
    out({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } },
    });
    delta('All done.');
    result('All done.');
  } else {
    init();
    delta('Hello ');
    delta('world');
    result('Hello world');
  }
});
