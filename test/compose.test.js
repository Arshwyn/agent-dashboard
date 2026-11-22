'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Settings the app reads on purpose that compose does not pass, with the reason.
const NOT_IN_COMPOSE = {
  DEV_AUTH_BYPASS: 'local development only; must never be set on a deployment',
  NODE_ENV: 'set by the image',
  HOST: 'set by the image (compose publishes on BIND_ADDR)',
  PORT: 'the container always listens on 8787; compose maps the published port',
};

function envNamesReadBySource() {
  const names = new Set();
  for (const f of fs.readdirSync(path.join(root, 'src'))) {
    for (const m of read(path.join('src', f)).matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function composeEnvironment() {
  const text = read('docker-compose.yml');
  const block = text.split(/^ {4}environment:\n/m)[1].split(/^ {4}\S/m)[0];
  return new Map([...block.matchAll(/^ {6}([A-Z][A-Z0-9_]+): (.*)$/gm)].map((m) => [m[1], m[2]]));
}

test('every setting the app reads is passed by compose or listed with a reason', () => {
  const env = composeEnvironment();
  const read_ = envNamesReadBySource();
  assert.ok(read_.length >= 10 && read_.includes('APOLLO_EMBED') && read_.includes('APOLLO_CHAT_URL'));
  for (const name of read_) {
    if (name in NOT_IN_COMPOSE) {
      assert.ok(!env.has(name) || name === 'PORT', `${name} is deliberately not passed`);
    } else assert.ok(env.has(name), `${name} is read by src/ but not passed in docker-compose.yml`);
  }
  for (const name of Object.keys(NOT_IN_COMPOSE))
    assert.ok(read_.includes(name), `${name} is no longer read`);
});

test('the Apollo settings default to off and empty, and no unsafe value is passed', () => {
  const env = composeEnvironment();
  assert.equal(env.get('APOLLO_EMBED'), '${APOLLO_EMBED:-0}');
  assert.equal(env.get('APOLLO_CHAT_URL'), '${APOLLO_CHAT_URL:-}');
  assert.equal(env.has('DEV_AUTH_BYPASS'), false);
});

test('the env example documents the compose-passed Apollo settings', () => {
  const ex = read('.env.example');
  assert.match(ex, /APOLLO_CHAT_URL=/);
  assert.match(ex, /APOLLO_EMBED=0/);
});
