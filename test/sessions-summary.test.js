'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('the sessions count shows N+ when the list reaches the store fetch limit', async () => {
  const { SESSIONS_LIMIT } = await import('../public/js/store.js');
  const { sessionCountLabel } = await import('../public/js/views/sessions.js');
  assert.equal(sessionCountLabel(0), '0');
  assert.equal(sessionCountLabel(SESSIONS_LIMIT - 1), String(SESSIONS_LIMIT - 1));
  assert.equal(sessionCountLabel(SESSIONS_LIMIT), `${SESSIONS_LIMIT}+`);
});
