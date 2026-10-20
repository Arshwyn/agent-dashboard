#!/usr/bin/env node
'use strict';
// Runs `node --test test/` with TMPDIR pointing at a per-run dir, then fails if the tests left
// anything behind in it. Only this run's dir is inspected, so concurrent runs do not interfere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-run-'));
const res = spawnSync(process.execPath, ['--test', 'test/', ...process.argv.slice(2)], {
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
