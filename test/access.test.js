'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccessVerifier } = require('../src/access');
const { TEAM, AUD, OWNER, jwk, other, makeToken } = require('./helpers');

function verifier(over = {}) {
  return new AccessVerifier({
    teamDomain: TEAM,
    aud: AUD,
    ownerEmail: OWNER,
    fetchJson: async () => ({ keys: [jwk] }),
    ...over,
  });
}

test('a valid token for the owner is accepted', async () => {
  const r = await verifier().verify(makeToken());
  assert.deepEqual(r, { ok: true, email: OWNER });
});

test('the email is compared case-insensitively; another email is 403', async () => {
  assert.equal((await verifier().verify(makeToken({ email: 'Owner@Example.com' }))).ok, true);
  const r = await verifier().verify(makeToken({ email: 'someone@example.com' }));
  assert.equal(r.status, 403);
  assert.equal((await verifier().verify(makeToken({ email: undefined }))).status, 403);
});

test('missing, malformed and unsigned tokens are 401', async () => {
  const v = verifier();
  for (const t of [undefined, '', 'abc', 'a.b', 'a.b.c.d', 'x'.repeat(9000)]) {
    assert.equal((await v.verify(t)).status, 401);
  }
  const none = `${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
  assert.equal((await v.verify(none)).status, 401);
});

test('a token signed by another key, with a tampered body, or an HS256 header is rejected', async () => {
  const v = verifier();
  assert.equal((await v.verify(makeToken({}, { key: other.privateKey }))).status, 401);
  const good = makeToken();
  const [h, , s] = good.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: OWNER, exp: 9999999999 })).toString('base64url')}.${s}`;
  assert.equal((await v.verify(forged)).status, 401);
  assert.equal((await v.verify(makeToken({}, { alg: 'HS256' }))).status, 401);
  assert.equal((await v.verify(makeToken({}, { kid: 'unknown' }))).status, 401);
});

test('issuer, audience, expiry and not-before are enforced', async () => {
  const v = verifier();
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await v.verify(makeToken({ iss: 'https://evil.example.com' }))).status, 401);
  assert.equal((await v.verify(makeToken({ aud: ['other'] }))).status, 401);
  assert.equal((await v.verify(makeToken({ aud: AUD }))).ok, true);
  assert.equal((await v.verify(makeToken({ exp: now - 3600 }))).status, 401);
  assert.equal((await v.verify(makeToken({ exp: undefined }))).status, 401);
  assert.equal((await v.verify(makeToken({ nbf: now + 3600 }))).status, 401);
});

test('a key fetch failure is unavailable (503), never an allow', async () => {
  const v = verifier({
    fetchJson: async () => {
      throw new Error('down');
    },
  });
  assert.equal((await v.verify(makeToken())).status, 503);
  const empty = verifier({ fetchJson: async () => ({ keys: [] }) });
  assert.equal((await empty.verify(makeToken())).status, 503);
});

test('keys are cached, and an unknown key id refetches at most once a minute', async () => {
  let calls = 0;
  let t = 1_000_000_000_000;
  const v = verifier({
    now: () => t,
    fetchJson: async () => {
      calls++;
      return { keys: [jwk] };
    },
  });
  const tok = makeToken({ exp: Math.floor(t / 1000) + 600, nbf: Math.floor(t / 1000) - 5 });
  await v.verify(tok);
  await v.verify(tok);
  assert.equal(calls, 1);
  const unknown = makeToken({ exp: Math.floor(t / 1000) + 600 }, { kid: 'nope' });
  await v.verify(unknown);
  await v.verify(unknown);
  assert.equal(calls, 1, 'within a minute no refetch');
  t += 61_000;
  await v.verify(unknown);
  assert.equal(calls, 2);
});

test('concurrent verifications share one key fetch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const v = verifier({
    fetchJson: async () => {
      calls++;
      await gate;
      return { keys: [jwk] };
    },
  });
  const all = Promise.all([1, 2, 3, 4, 5].map(() => v.verify(makeToken())));
  await new Promise((r) => setImmediate(r));
  release();
  const rs = await all;
  assert.equal(calls, 1);
  assert.ok(rs.every((r) => r.ok));
});

test('a failed key fetch stays unavailable (503) inside the throttle window, then retries', async () => {
  let t = 1_000_000_000_000;
  let calls = 0;
  let fail = true;
  const v = verifier({
    now: () => t,
    fetchJson: async () => {
      calls++;
      if (fail) throw new Error('down');
      return { keys: [jwk] };
    },
  });
  const tok = () => makeToken({ exp: Math.floor(t / 1000) + 600, nbf: Math.floor(t / 1000) - 5 });
  assert.equal((await v.verify(tok())).status, 503);
  t += 5000;
  assert.equal((await v.verify(tok())).status, 503, 'throttled request is still 503, not 401');
  assert.equal(calls, 1);
  t += 61_000;
  fail = false;
  assert.equal((await v.verify(tok())).ok, true);
  assert.equal(calls, 2);
});
