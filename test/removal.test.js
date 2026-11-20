'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('the pipeline, office and cost code and assets are removed', () => {
  for (const p of [
    'src/state.js',
    'src/cost.js',
    'src/pricing.js',
    'src/handoff.js',
    'src/db.js',
    'public/office',
    'public/js/store.js',
    'art',
    'e2e',
    'scripts/demo.js',
    'scripts/build-office-atlas.js',
    'scripts/emit-pipeline-event.sh',
  ]) {
    assert.ok(!fs.existsSync(path.join(root, p)), `${p} should be gone`);
  }
});

test('the hook script is a fail-open no-op', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'hook.js')], {
    input: '{"hook_event_name":"PreToolUse"}',
    timeout: 5000,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length + r.stderr.length, 0);
});

test('no real hostnames, emails or personal paths are committed in the app files', () => {
  const bad =
    /(\/home\/\w+|192\.168\.\d+\.\d+|@(?!example\.com|users\.noreply)[a-z0-9-]+\.(com|net|org|io))/i;
  for (const dir of ['src', 'public/js', 'public/css', 'test', 'docs']) {
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const f of walk(path.join(root, dir))) {
      if (/\.(glb|png)$/.test(f) || f.endsWith('removal.test.js')) continue;
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), bad, f);
    }
  }
});
