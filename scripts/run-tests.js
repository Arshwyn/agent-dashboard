#!/usr/bin/env node
'use strict';
// Runs `node --test` on every test/*.test.js file, listed explicitly because directory arguments are
// rejected on Node 22+ and glob patterns are not expanded on Node 20. TMPDIR points at a per-run dir,
// and the run fails if the tests left anything behind in it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testFiles = fs
  .readdirSync('test')
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', f));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-run-'));
const res = spawnSync(process.execPath, ['--test', ...testFiles, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: runDir, TMP: runDir, TEMP: runDir },
});
let code = res.status === null ? 1 : res.status;
const leftovers = fs.readdirSync(runDir);
if (leftovers.length > 0) {
  console.error(`Tests left temp files behind in ${runDir}:\n  ${leftovers.join('\n  ')}`);
  code = code || 1;
}
fs.rmSync(runDir, { recursive: true, force: true });
process.exit(code);
