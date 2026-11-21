'use strict';

// Conversation history for the single owner. Two implementations share one contract:
//   openStore(path)    SQLite through better-sqlite3 (Node 22 or later), used by the real server
//   createMemoryStore  plain objects, used by tests on any Node version
// A conversation's id is a UUID and is also the Claude session id of its runs.
const crypto = require('node:crypto');

const MAX_TITLE = 80;

function cleanTitle(t) {
  const s = String(t ?? '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
  return s;
}

function openStore(file) {
  const Database = require('better-sqlite3');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      title TEXT NOT NULL,
      session_started INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversations_agent ON conversations(agent, updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
  `);
  const q = {
    insertConv: db.prepare(
      'INSERT INTO conversations (id, agent, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    listConv: db.prepare(
      'SELECT id, agent, title, session_started, created_at, updated_at FROM conversations WHERE agent = ? ORDER BY updated_at DESC, created_at DESC LIMIT 200',
    ),
    getConv: db.prepare(
      'SELECT id, agent, title, session_started, created_at, updated_at FROM conversations WHERE id = ?',
    ),
    rename: db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?'),
    touch: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
    started: db.prepare('UPDATE conversations SET session_started = 1 WHERE id = ?'),
    del: db.prepare('DELETE FROM conversations WHERE id = ?'),
    insertMsg: db.prepare(
      'INSERT INTO messages (conversation_id, role, text, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    listMsg: db.prepare(
      'SELECT id, role, text, status, error_code, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC',
    ),
    delMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
    updMsg: db.prepare('UPDATE messages SET text = ?, status = ?, error_code = ? WHERE id = ?'),
    stale: db.prepare(
      "UPDATE messages SET status = 'error', error_code = 'interrupted' WHERE status = 'streaming'",
    ),
    count: db.prepare('SELECT COUNT(*) AS n FROM conversations'),
  };
  const conv = (r) => (r ? { ...r, session_started: r.session_started === 1 } : null);
  return {
    createConversation(agent, title = 'New chat', now = Date.now()) {
      const id = crypto.randomUUID();
      q.insertConv.run(id, agent, cleanTitle(title) || 'New chat', now, now);
      return conv(q.getConv.get(id));
    },
    listConversations: (agent) => q.listConv.all(agent).map(conv),
    getConversation: (id) => conv(q.getConv.get(id)),
    renameConversation(id, title, now = Date.now()) {
      const t = cleanTitle(title);
      if (!t) return false;
      return q.rename.run(t, now, id).changes === 1;
    },
    markSessionStarted: (id) => q.started.run(id),
    deleteConversation: (id) => q.del.run(id).changes === 1,
    addMessage(conversationId, role, text, status = 'done', now = Date.now()) {
      const r = q.insertMsg.run(conversationId, role, text, status, now);
      q.touch.run(now, conversationId);
      return Number(r.lastInsertRowid);
    },
    updateMessage(id, { text, status, errorCode = null }) {
      q.updMsg.run(text, status, errorCode, id);
    },
    /** Removes one message (a send the gateway refused leaves no row behind). */
    deleteMessage: (id) => q.delMsg.run(id).changes === 1,
    listMessages: (conversationId) => q.listMsg.all(conversationId),
    /** Messages left 'streaming' by a restart can never finish. */
    markInterrupted: () => q.stale.run().changes,
    conversationCount: () => q.count.get().n,
    close: () => db.close(),
  };
}

function createMemoryStore() {
  const convs = new Map();
  const msgs = [];
  let nextId = 1;
  const copy = (c) => (c ? { ...c } : null);
  return {
    createConversation(agent, title = 'New chat', now = Date.now()) {
      const id = crypto.randomUUID();
      convs.set(id, {
        id,
        agent,
        title: cleanTitle(title) || 'New chat',
        session_started: false,
        created_at: now,
        updated_at: now,
      });
      return copy(convs.get(id));
    },
    listConversations: (agent) =>
      [...convs.values()]
        .filter((c) => c.agent === agent)
        .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at)
        .map(copy),
    getConversation: (id) => copy(convs.get(id)),
    renameConversation(id, title, now = Date.now()) {
      const c = convs.get(id);
      const t = cleanTitle(title);
      if (!c || !t) return false;
      c.title = t;
      c.updated_at = now;
      return true;
    },
    markSessionStarted(id) {
      const c = convs.get(id);
      if (c) c.session_started = true;
    },
    deleteConversation(id) {
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].conversation_id === id) msgs.splice(i, 1);
      return convs.delete(id);
    },
    addMessage(conversationId, role, text, status = 'done', now = Date.now()) {
      const m = {
        id: nextId++,
        conversation_id: conversationId,
        role,
        text,
        status,
        error_code: null,
        created_at: now,
      };
      msgs.push(m);
      const c = convs.get(conversationId);
      if (c) c.updated_at = now;
      return m.id;
    },
    updateMessage(id, { text, status, errorCode = null }) {
      const m = msgs.find((x) => x.id === id);
      if (m) Object.assign(m, { text, status, error_code: errorCode });
    },
    deleteMessage(id) {
      const i = msgs.findIndex((m) => m.id === id);
      if (i < 0) return false;
      msgs.splice(i, 1);
      return true;
    },
    listMessages: (conversationId) =>
      msgs
        .filter((m) => m.conversation_id === conversationId)
        .map(({ conversation_id: _c, ...m }) => ({ ...m })),
    markInterrupted() {
      let n = 0;
      for (const m of msgs) {
        if (m.status === 'streaming') {
          Object.assign(m, { status: 'error', error_code: 'interrupted' });
          n++;
        }
      }
      return n;
    },
    conversationCount: () => convs.size,
    close() {},
  };
}

module.exports = { openStore, createMemoryStore, cleanTitle };
