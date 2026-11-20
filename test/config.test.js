'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, startupWarnings } = require('../src/config');
const { baseEnv, AUD } = require('./helpers');

test('a complete environment loads with safe defaults', () => {
  const c = loadConfig(baseEnv());
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 8787);
  assert.equal(c.devBypass, false);
  assert.equal(c.ownerEmail, 'owner@example.com');
  assert.equal(c.apolloChatUrl, '');
});

test('missing or malformed Access settings fail closed', () => {
  assert.throws(() => loadConfig({}), /ACCESS_TEAM_DOMAIN/);
  assert.throws(
    () => loadConfig(baseEnv({ ACCESS_TEAM_DOMAIN: 'https://team.example.com' })),
    /ACCESS_TEAM_DOMAIN/,
  );
  assert.throws(() => loadConfig(baseEnv({ ACCESS_AUD: 'short' })), /ACCESS_AUD/);
  assert.throws(() => loadConfig(baseEnv({ OWNER_EMAIL: 'nobody' })), /OWNER_EMAIL/);
  assert.throws(() => loadConfig(baseEnv({ PORT: 'abc' })), /PORT/);
  assert.ok(AUD.length >= 16);
});

test('the dev bypass needs loopback and is refused in production or with a bad value', () => {
  const c = loadConfig({ DEV_AUTH_BYPASS: '1' });
  assert.equal(c.devBypass, true);
  assert.equal(startupWarnings(c).length, 1);
  assert.throws(() => loadConfig({ DEV_AUTH_BYPASS: '1', NODE_ENV: 'production' }), /production/);
  assert.throws(() => loadConfig({ DEV_AUTH_BYPASS: '1', HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ DEV_AUTH_BYPASS: 'yes' }), /DEV_AUTH_BYPASS/);
  assert.equal(loadConfig(baseEnv({ DEV_AUTH_BYPASS: '0' })).devBypass, false);
  assert.equal(startupWarnings(loadConfig(baseEnv())).length, 0);
});

test('APOLLO_CHAT_URL must be https (or loopback http) and is optional', () => {
  assert.equal(
    loadConfig(baseEnv({ APOLLO_CHAT_URL: 'https://chat.example.com/' })).apolloChatUrl,
    'https://chat.example.com/',
  );
  assert.throws(() => loadConfig(baseEnv({ APOLLO_CHAT_URL: 'http://chat.example.com' })), /APOLLO_CHAT_URL/);
  assert.throws(() => loadConfig(baseEnv({ APOLLO_CHAT_URL: 'javascript:alert(1)' })), /APOLLO_CHAT_URL/);
  assert.throws(() => loadConfig(baseEnv({ APOLLO_CHAT_URL: 'nope' })), /APOLLO_CHAT_URL/);
});
