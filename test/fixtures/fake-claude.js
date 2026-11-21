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
  '--disallowedTools',
];
const bad = need.filter((f) => !argv.includes(f));
const val = (f) => argv[argv.indexOf(f) + 1];
// the pilot runs in auto mode with prompts off; any bypass flag or mode is a failure
const allowed = new Set([...need, '--agent', '--model', '--session-id', '--resume']);
const unknownFlag = argv.some((a) => a.startsWith('-') && !allowed.has(a));
const unsafe = unknownFlag || argv.some((a) => /bypass|dangerously|skip-permissions/i.test(a));
const denied = argv
  .slice(argv.indexOf('--disallowedTools') + 1)
  .filter((_, i, a) => !a.slice(0, i + 1).some((x) => x.startsWith('-')));
if (
  bad.length ||
  unsafe ||
  val('--output-format') !== 'stream-json' ||
  val('--permission-mode') !== 'auto' ||
  val('--permission-prompts') !== 'none' ||
  !denied.includes('Agent(apollo)')
) {
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
  } else if (p.startsWith('stray')) {
    // leaves a background child behind in the process group, then ends normally
    const kid = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(process.env.HOME, 'stray.pid'), String(kid.pid));
    init();
    delta('ok');
    result('ok');
    process.exit(0);
  } else if (p.startsWith('escape')) {
    // a sleeper in its own session that keeps our stdout open after we exit
    const kid = require('node:child_process').spawn('sleep', ['30'], {
      detached: true,
      stdio: ['ignore', 'inherit', 'ignore'],
    });
    fs.writeFileSync(path.join(process.env.HOME, 'escape.pid'), String(kid.pid));
    kid.unref();
    init();
    delta('ok');
    result('ok');
    process.exit(0);
  } else if (p.startsWith('toolfail')) {
    init();
    out({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tf1', name: 'Bash' } },
    });
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
      session_id: sid,
    });
    process.exit(1);
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
