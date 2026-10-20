'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const COLS = [
  'ts',
  'agent',
  'session_id',
  'type',
  'tool',
  'summary',
  'task',
  'repo',
  'branch',
  'tokens_in',
  'tokens_out',
  'cost_usd',
  'meta',
  'usage',
  'snapshot',
  'cost_source',
  'pricing_version',
  'unpriced_tokens',
  'instance',
];

// Columns added after the first release. Added with ALTER TABLE only when missing, so the
// migration is idempotent and non-destructive on an existing database file.
const MIGRATIONS = [
  ['usage', 'TEXT'],
  ['snapshot', 'TEXT'],
  ['cost_source', 'TEXT'],
  ['pricing_version', 'TEXT'],
  ['unpriced_tokens', 'INTEGER'],
  ['instance', 'TEXT'],
];
const JSON_COLS = ['meta', 'usage', 'snapshot'];

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function rowToEvent(r) {
  if (!r) return r;
  // The cumulative snapshot is server bookkeeping and is never exposed.
  // eslint-disable-next-line no-unused-vars
  const { snapshot, ...rest } = r;
  return { ...rest, meta: parseJson(r.meta), usage: parseJson(r.usage) };
}

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      tool TEXT,
      summary TEXT,
      task TEXT,
      repo TEXT,
      branch TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
    CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events (agent, ts);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);
  `);

  const have = new Set(
    db
      .prepare('PRAGMA table_info(events)')
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of MIGRATIONS) {
    if (!have.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_events_snapshot ON events (session_id, ts) WHERE snapshot IS NOT NULL',
  );

  const insertStmt = db.prepare(
    `INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map((c) => '@' + c).join(',')})`,
  );
  const getStmt = db.prepare('SELECT * FROM events WHERE id = ?');

  return {
    raw: db,
    insertEvent(ev) {
      const row = {};
      for (const c of COLS) row[c] = ev[c] === undefined ? null : ev[c];
      for (const c of JSON_COLS) row[c] = ev[c] ? JSON.stringify(ev[c]) : null;
      const info = insertStmt.run(row);
      return rowToEvent(getStmt.get(info.lastInsertRowid));
    },
    /** Newest first. `before` is an event id cursor. */
    listEvents({ limit = 50, before = null, agent = null, instance = null } = {}) {
      const where = [];
      const params = {};
      if (before) {
        where.push('id < @before');
        params.before = before;
      }
      if (agent) {
        where.push('agent = @agent');
        params.agent = agent;
      }
      if (instance) {
        where.push('instance = @instance');
        params.instance = instance;
      }
      const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT @limit`;
      return db
        .prepare(sql)
        .all({ ...params, limit })
        .map(rowToEvent);
    },
    eventsSince(id, limit = 500) {
      return db
        .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
        .all(id, limit)
        .map(rowToEvent);
    },
    eventsFromTs(ts, types = null) {
      const rows = types
        ? db
            .prepare(
              `SELECT * FROM events WHERE ts >= ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY ts ASC, id ASC`,
            )
            .all(ts, ...types)
        : db.prepare('SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC, id ASC').all(ts);
      return rows.map(rowToEvent);
    },
    /** Newest cumulative snapshot stored for a session: { ts, usage } or null. */
    latestSnapshot(sessionId) {
      const r = db
        .prepare(
          'SELECT ts, snapshot FROM events WHERE session_id = ? AND snapshot IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1',
        )
        .get(sessionId);
      return r ? { ts: r.ts, usage: parseJson(r.snapshot) } : null;
    },
    /** Events that carry token or cost data, oldest first. */
    usageEventsFrom(ts) {
      return db
        .prepare(
          `SELECT * FROM events WHERE ts >= ? AND (usage IS NOT NULL OR tokens_in IS NOT NULL OR tokens_out IS NOT NULL OR cost_usd IS NOT NULL) ORDER BY ts ASC, id ASC`,
        )
        .all(ts)
        .map(rowToEvent);
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    },
    /** Delete events older than retention and keep at most maxRows newest. Returns rows deleted. */
    prune({ retentionDays, maxRows, now = Date.now() }) {
      let deleted = 0;
      deleted += db
        .prepare('DELETE FROM events WHERE ts < ?')
        .run(now - retentionDays * 86400 * 1000).changes;
      const over = db.prepare('SELECT COUNT(*) AS n FROM events').get().n - maxRows;
      if (over > 0) {
        deleted += db
          .prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id ASC LIMIT ?)')
          .run(over).changes;
      }
      return deleted;
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openDb };
