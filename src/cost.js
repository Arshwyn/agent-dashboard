'use strict';

const { TOKEN_CLASSES, emptyClasses, classTotal, computeCost, snapshotDelta } = require('./pricing');

const DAY_MS = 86400 * 1000;

/**
 * Ingest-time pricing. Mutates and returns the validated event so that it carries the computed
 * cost, the raw per-model tokens and the pricing version. Precedence (README "Tokens and cost"):
 *  - usage present: the server-computed cost always wins; a sender cost_usd is ignored.
 *  - no usage but a sender cost_usd: kept, cost_source "reported".
 *  - neither: unpriced (tokens, if any, are counted in unpriced_tokens).
 * session_cumulative usage (top-level Stop) is turned into the delta since the previous snapshot
 * of the same session_id, so repeated Stops never double-count.
 */
function priceEvent(ev, { store, pricing, onUnknownModel = () => {} }) {
  const scope = ev.usage_scope;
  delete ev.usage_scope;
  if (ev.usage) {
    let usage = ev.usage;
    if (scope === 'session_cumulative') {
      const prev = store.latestSnapshot(ev.session_id);
      if (prev && ev.ts < prev.ts) {
        // Older than the snapshot we already hold (out of order): adds nothing, baseline kept.
        usage = {};
        ev.meta = { ...ev.meta, stale_snapshot: true };
      } else {
        const { delta, reset } = snapshotDelta(prev && prev.usage, usage);
        ev.snapshot = usage;
        usage = delta;
        if (reset) ev.meta = { ...ev.meta, baseline_reset: true };
      }
    }
    const cost = computeCost(usage, pricing);
    const stored = {};
    let tin = 0;
    let tout = 0;
    for (const [model, c] of Object.entries(usage)) {
      stored[model] = { ...c, cost_usd: cost.per_model[model] };
      tin += c.input + c.cache_write_5m + c.cache_write_1h;
      tout += c.output;
    }
    for (const m of cost.unknown_models) onUnknownModel(m);
    ev.usage = stored;
    ev.tokens_in = tin;
    ev.tokens_out = tout;
    ev.cost_usd = cost.cost_usd;
    ev.cost_source = 'computed';
    ev.pricing_version = pricing.version;
    ev.unpriced_tokens = cost.unpriced_tokens;
    return ev;
  }
  if (ev.cost_usd !== null && ev.cost_usd !== undefined) {
    ev.cost_source = 'reported';
    ev.unpriced_tokens = 0;
  } else {
    ev.unpriced_tokens = (ev.tokens_in || 0) + (ev.tokens_out || 0);
  }
  return ev;
}

// ---------------------------------------------------------------- aggregation

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function newAgg() {
  return {
    cost_usd: 0,
    tokens: emptyClasses(),
    legacy_tokens: { in: 0, out: 0 },
    unpriced_tokens: 0,
    models: new Map(),
  };
}

/** Fold one stored event row into an aggregate. Rows with no token or cost data are ignored. */
function addRow(agg, row) {
  if (row.usage) {
    for (const [model, c] of Object.entries(row.usage)) {
      let m = agg.models.get(model);
      if (!m) {
        m = { model, tokens: emptyClasses(), cost_usd: 0, unpriced_tokens: 0 };
        agg.models.set(model, m);
      }
      const tot = classTotal(c);
      for (const k of TOKEN_CLASSES) {
        agg.tokens[k] += c[k] || 0;
        m.tokens[k] += c[k] || 0;
      }
      if (typeof c.cost_usd === 'number') m.cost_usd += c.cost_usd;
      else m.unpriced_tokens += tot;
    }
    agg.cost_usd += row.cost_usd || 0;
    agg.unpriced_tokens += row.unpriced_tokens || 0;
    return;
  }
  // Legacy rows (no per-model data): priced only when the sender reported a cost.
  const tin = row.tokens_in || 0;
  const tout = row.tokens_out || 0;
  agg.legacy_tokens.in += tin;
  agg.legacy_tokens.out += tout;
  if (row.cost_source === 'reported') agg.cost_usd += row.cost_usd || 0;
  else agg.unpriced_tokens += tin + tout;
}

function finishAgg(agg) {
  const models = [...agg.models.values()]
    .map((m) => ({
      model: m.model,
      tokens: m.tokens,
      cost_usd: round6(m.cost_usd),
      unpriced_tokens: m.unpriced_tokens,
      priced: m.unpriced_tokens === 0,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.model.localeCompare(b.model));
  return {
    cost_usd: round6(agg.cost_usd),
    tokens: agg.tokens,
    legacy_tokens: agg.legacy_tokens,
    unpriced_tokens: agg.unpriced_tokens,
    cost_incomplete: agg.unpriced_tokens > 0,
    models,
  };
}

/** Subagent sessions are `<sid>:<agent_id>`; they roll up to their parent `<sid>`. */
function parentSession(id) {
  const i = id.indexOf(':');
  return i > 0 ? id.slice(0, i) : id;
}

/** Per-session cost, newest activity first. */
function aggregateSessions(rows, { limit = 50 } = {}) {
  const by = new Map();
  for (const row of rows) {
    const sid = parentSession(row.session_id);
    let s = by.get(sid);
    if (!s) {
      s = {
        session_id: sid,
        agents: new Set(),
        repo: null,
        first_ts: row.ts,
        last_ts: row.ts,
        agg: newAgg(),
        subs: new Set(),
      };
      by.set(sid, s);
    }
    s.agents.add(row.agent);
    if (row.repo) s.repo = row.repo;
    if (row.ts < s.first_ts) s.first_ts = row.ts;
    if (row.ts > s.last_ts) s.last_ts = row.ts;
    if (row.session_id !== sid) s.subs.add(row.session_id);
    addRow(s.agg, row);
  }
  return [...by.values()]
    .sort((a, b) => b.last_ts - a.last_ts)
    .slice(0, limit)
    .map((s) => {
      const f = finishAgg(s.agg);
      return {
        session_id: s.session_id,
        agents: [...s.agents].sort(),
        repo: s.repo,
        subagent_sessions: s.subs.size,
        first_ts: s.first_ts,
        last_ts: s.last_ts,
        ...f,
      };
    });
}

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/** Overall cost summary for the last `days` UTC days (today included). */
function aggregateCosts(rows, { days, now, retentionDays, pricing, unknownModels = [] }) {
  const fromTs = Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  const total = newAgg();
  const byAgent = new Map();
  const byDay = new Map();
  const sessions = new Set();
  for (let i = 0; i < days; i++) byDay.set(dayKey(fromTs + i * DAY_MS), newAgg());
  for (const row of rows) {
    if (row.ts < fromTs) continue;
    addRow(total, row);
    sessions.add(parentSession(row.session_id));
    if (!byAgent.has(row.agent)) byAgent.set(row.agent, newAgg());
    addRow(byAgent.get(row.agent), row);
    const d = byDay.get(dayKey(row.ts));
    if (d) addRow(d, row);
  }
  const t = finishAgg(total);
  const sum = (a) => classTotal(a.tokens) + a.legacy_tokens.in + a.legacy_tokens.out;
  const by_day = [...byDay.entries()].map(([day, a]) => {
    const f = finishAgg(a);
    return { day, cost_usd: f.cost_usd, tokens: sum(f), unpriced_tokens: f.unpriced_tokens };
  });
  const by_agent = [...byAgent.entries()]
    .map(([agent, a]) => {
      const f = finishAgg(a);
      return { agent, cost_usd: f.cost_usd, tokens: sum(f), unpriced_tokens: f.unpriced_tokens };
    })
    .sort((a, b) => b.cost_usd - a.cost_usd || a.agent.localeCompare(b.agent));
  const today = by_day[by_day.length - 1];
  return {
    window: {
      from_ts: fromTs,
      to_ts: now,
      days,
      retention_days: retentionDays,
      note: `Covers the last ${days} UTC day(s); older data is limited by the ${retentionDays}-day event retention.`,
    },
    pricing: { version: pricing.version, as_of: pricing.as_of },
    total: {
      cost_usd: t.cost_usd,
      tokens: t.tokens,
      legacy_tokens: t.legacy_tokens,
      unpriced_tokens: t.unpriced_tokens,
      cost_incomplete: t.cost_incomplete,
    },
    today: {
      day: today.day,
      cost_usd: today.cost_usd,
      tokens: today.tokens,
      unpriced_tokens: today.unpriced_tokens,
    },
    sessions: sessions.size,
    by_model: t.models,
    by_agent,
    by_day,
    unknown_models: [...unknownModels].sort(),
  };
}

module.exports = { priceEvent, aggregateSessions, aggregateCosts, parentSession };
