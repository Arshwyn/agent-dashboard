'use strict';

const nodeTest = require('node:test');
const test = nodeTest;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore, openStore, cleanTitle } = require('../src/store');

// SQLite needs Node 22 or later (better-sqlite3 13); on older Node only the memory store is exercised.
const sqliteOk = Number(process.versions.node.split('.')[0]) >= 22;

function contract(name, make, skip = false) {
  const test = (n, f) => nodeTest(n, { skip }, f);
  test(`${name}: conversations and messages round-trip`, () => {
    const { store, done } = make();
    try {
      const c = store.createConversation('arshwyn', 'First', 1000);
      assert.match(c.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(c.session_started, false);
      assert.equal(store.getConversation(c.id).title, 'First');
      assert.equal(store.getConversation('missing'), null);
      store.addMessage(c.id, 'user', 'hello', 'done', 2000);
      const mid = store.addMessage(c.id, 'assistant', '', 'streaming', 2001);
      store.updateMessage(mid, { text: 'hi', status: 'done' });
      const msgs = store.listMessages(c.id);
      assert.deepEqual(
        msgs.map((m) => [m.role, m.text, m.status]),
        [
          ['user', 'hello', 'done'],
          ['assistant', 'hi', 'done'],
        ],
      );
      assert.equal(store.getConversation(c.id).updated_at, 2001);
      store.markSessionStarted(c.id);
      assert.equal(store.getConversation(c.id).session_started, true);
    } finally {
      done();
    }
  });

  test(`${name}: a message can be deleted by id`, () => {
    const { store, done } = make();
    try {
      const c = store.createConversation('arshwyn', 'D', 1);
      const a = store.addMessage(c.id, 'user', 'one', 'done', 2);
      const b = store.addMessage(c.id, 'assistant', '', 'streaming', 3);
      assert.equal(store.deleteMessage(b), true);
      assert.equal(store.deleteMessage(b), false);
      assert.deepEqual(
        store.listMessages(c.id).map((m) => m.id),
        [a],
      );
    } finally {
      done();
    }
  });

  test(`${name}: list is per agent and newest first; rename cleans the title; delete cascades`, () => {
    const { store, done } = make();
    try {
      const a = store.createConversation('arshwyn', 'A', 1);
      const b = store.createConversation('arshwyn', 'B', 2);
      store.createConversation('themis', 'T', 3);
      assert.deepEqual(
        store.listConversations('arshwyn').map((c) => c.title),
        ['B', 'A'],
      );
      assert.equal(store.renameConversation(a.id, '  a\n  new\u0007 title  ', 10), true);
      assert.equal(store.getConversation(a.id).title, 'a new title');
      assert.equal(store.renameConversation(a.id, '   ', 11), false);
      assert.equal(store.renameConversation('nope', 'x'), false);
      assert.deepEqual(
        store.listConversations('arshwyn').map((c) => c.title),
        ['a new title', 'B'],
      );
      store.addMessage(b.id, 'user', 'x');
      assert.equal(store.deleteConversation(b.id), true);
      assert.equal(store.deleteConversation(b.id), false);
      assert.deepEqual(store.listMessages(b.id), []);
      assert.equal(store.conversationCount(), 2);
    } finally {
      done();
    }
  });

  test(`${name}: messages left streaming by a restart are marked interrupted`, () => {
    const { store, done } = make();
    try {
      const c = store.createConversation('arshwyn');
      const id = store.addMessage(c.id, 'assistant', 'part', 'streaming');
      store.addMessage(c.id, 'assistant', 'ok', 'done');
      assert.equal(store.markInterrupted(), 1);
      const m = store.listMessages(c.id);
      assert.equal(m.find((x) => x.id === id).status, 'error');
      assert.equal(m.find((x) => x.id === id).error_code, 'interrupted');
      assert.equal(store.markInterrupted(), 0);
    } finally {
      done();
    }
  });
}

contract('memory store', () => ({ store: createMemoryStore(), done() {} }));
contract(
  'sqlite store',
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-db-'));
    const store = openStore(path.join(dir, 'h.db'));
    return {
      store,
      done() {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  !sqliteOk && 'needs Node 22+ for better-sqlite3',
);

test(
  'sqlite store: data survives a reopen and only parameters reach SQL',
  { skip: !sqliteOk && 'needs Node 22+ for better-sqlite3' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-db-'));
    try {
      const file = path.join(dir, 'h.db');
      let s = openStore(file);
      const c = s.createConversation('arshwyn', "x'); DROP TABLE conversations;--");
      s.addMessage(c.id, 'user', "'; DELETE FROM messages;--");
      s.close();
      s = openStore(file);
      assert.equal(s.getConversation(c.id).title, "x'); DROP TABLE conversations;--");
      assert.equal(s.listMessages(c.id)[0].text, "'; DELETE FROM messages;--");
      s.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('titles are cleaned and capped', () => {
  assert.equal(cleanTitle('x'.repeat(200)).length, 80);
  assert.equal(cleanTitle(undefined), '');
});
