'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function listFiles(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(dir, rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

// First 12 hex chars of a sha256 over the sorted relative paths and contents of every file
// under `dir`. Deterministic for identical content. Never throws: on failure it falls back to
// a startup-time value (still unique per process start).
function computeAssetVersion(dir) {
  try {
    const h = crypto.createHash('sha256');
    for (const rel of listFiles(dir).sort()) {
      const data = fs.readFileSync(path.join(dir, rel));
      h.update(`${rel}\0${data.length}\0`).update(data);
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return crypto.createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12);
  }
}

function strongEtag(data) {
  return `"${crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)}"`;
}

function etagMatches(header, etag) {
  if (typeof header !== 'string') return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v === etag;
  });
}

// True when a request-path remainder is safe to join under the public dir. The raw (still
// percent-encoded) path is checked: encoded dots, slashes, backslashes and NUL are all refused.
function safeRelPath(rel) {
  if (!rel || rel.includes('%') || rel.includes('\\') || rel.includes('\0')) return false;
  return !rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

module.exports = { computeAssetVersion, strongEtag, etagMatches, safeRelPath };
