'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir } = require('./helpers');

test('tempDir creates an ad- dir under os.tmpdir(), removes it via t.after, and is idempotent', () => {
  let hook;
  const dir = tempDir({ after: (fn) => (hook = fn) });
  assert.ok(path.basename(dir).startsWith('ad-'));
  assert.equal(path.dirname(dir), os.tmpdir());
  assert.ok(fs.statSync(dir).isDirectory());
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  hook();
  assert.equal(fs.existsSync(dir), false);
  assert.doesNotThrow(() => hook());
});
