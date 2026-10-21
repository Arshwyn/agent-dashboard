'use strict';

const { detectHandoff } = require('./handoff');

/**
 * Derived state. Pure in-memory trackers fed one event at a time (and rebuilt from the DB at
 * startup), so the REST API and SSE share one source of truth.
 *
 * STATUS ENUM (stable contract, see README "Adding a skin"): idle | working | blocked | done
 */

const STATUSES = ['idle', 'working', 'blocked', 'done'];
// A person who just finished is shown as `resting` (derived, never stored on events).
const VIEW_STATUSES = [...STATUSES, 'resting'];
const ACTIVITY = new Set(['tool_start', 'tool_end', 'status']);
const DAY_MS = 86400 * 1000;

function utcDay(ts) {
  return Math.floor(ts / DAY_MS);
}

function newTotals() {
  return { tokens_in: 0, tokens_out: 0, cost_usd: 0, unpriced_tokens: 0 };
}

// Agents retired in favour of verify / review. Events naming them are still accepted and stored,
// but they never get a card or an office character. (The pipeline gate names stay valid, see SUBSTEP_PARENT.)
const RETIRED_AGENTS = ['test', 'styling', 'security', 'code-review'];

// Names that never get a card: the retired agents, plus `unknown` (the hook's name for a top-level
// session that matches no role, e.g. a Claude session in another repo). Their events are still accepted
// and stored (cost and the feed keep counting them); they are just not tracked.
const UNTRACKED_AGENTS = [...RETIRED_AGENTS, 'unknown'];

// Named people. Every subagent event (session_id `<sid>:<agent_id>`) of any tracked role is done by one
// person from a single global pool (the lowest free one who is not resting). A person is busy from the
// first event of an agent until its `subagent_stop` (or until it is stale), then rests for the cooldown.
// The server stores the person's name in `instance` (`extra-<n>` when every pool member is busy), and
// replay trusts the stored value. Top-level events and untracked names are never pooled.
const MAX_PEOPLE = 99;
const RESUME_MS = 60 * 60 * 1000; // an agent keeps its person this long after its last event
const MAX_MAPPINGS = 2000;
const HANDOFF_SHOW_MS = 2 * 60 * 1000;
const EXTRA_RE = /^extra-([1-9]\d?)$/;

/** The agent-id part of a subagent session id (`<sid>:<agent_id>`), or null for a top-level session. */
function agentPart(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const i = sessionId.lastIndexOf(':');
  return i > 0 && i < sessionId.length - 1 ? sessionId.slice(i + 1) : null;
}

class AgentTracker {
  constructor({
    doneToIdleSeconds = 60,
    staleMinutes = 10,
    configured = [],
    maxAgents = 100,
    names = [],
    cooldownSeconds = 60,
    handoffWindowSeconds = 120,
    displayNames = {},
  } = {}) {
    this.displayNames = displayNames;
    this.maxAgents = maxAgents;
    this.names = names;
    this.cooldownMs = cooldownSeconds * 1000;
    this.handoffMs = handoffWindowSeconds * 1000;
    this.workers = new Map(); // session_id -> { person, role, last_ts, stopped, stop_ts }
    this.released = new Map(); // person -> newest release ts of workers already swept
    this.lastStop = null; // { person, role, ts } of the newest subagent_stop
    this.doneToIdleMs = doneToIdleSeconds * 1000;
    this.staleMs = staleMinutes * 60 * 1000;
    this.configured = configured;
    this.agents = new Map();
    // The whole pool is always on the board, idle until someone is assigned.
    for (const name of names) this._get(name, null, true);
  }

  _get(id, role = id, person = false) {
    const name = id;
    let a = this.agents.get(name);
    if (!a) {
      a = {
        agent: role,
        id,
        person,
        handoff: null,
        raw_status: 'idle',
        current_task: null,
        since: null,
        run_started_ts: null,
        last_event_ts: null,
        last_summary: null,
        last_tool: null,
        session_id: null,
        repo: null,
        branch: null,
        run: newTotals(),
        today: newTotals(),
        today_day: null,
      };
      this.agents.set(name, a);
    }
    return a;
  }

  /** True if an event for this agent name may be accepted (known, or under the cap on cards). */
  canTrack(name, instance = null) {
    if (UNTRACKED_AGENTS.includes(name)) return true; // accepted and stored, but never tracked
    return this.agents.has(instance || name) || this.agents.size < this.maxAgents;
  }

  /** True for a subagent event that is pooled (any tracked role). */
  isPooled(ev) {
    return (
      ev.type !== 'pipeline' && !UNTRACKED_AGENTS.includes(ev.agent) && agentPart(ev.session_id) !== null
    );
  }

  _busy(person, now, exceptKey = null) {
    for (const [key, w] of this.workers) {
      if (key !== exceptKey && w.person === person && !w.stopped && now - w.last_ts <= this.staleMs)
        return true;
    }
    return false;
  }

  /** When the person last became free (stop, or stale), or null while busy / never worked. */
  _releasedAt(person, now) {
    if (this._busy(person, now)) return null;
    let r = this.released.get(person) ?? null;
    for (const w of this.workers.values()) {
      if (w.person !== person) continue;
      const at = w.stopped ? w.stop_ts : w.last_ts + this.staleMs;
      if (r === null || at > r) r = at;
    }
    return r;
  }

  /** Ms timestamp the person's rest ends, or null (busy, never worked, no cooldown, or rested). */
  _cooldownUntil(person, now) {
    if (this.cooldownMs <= 0) return null;
    const r = this._releasedAt(person, now);
    if (r === null) return null;
    const until = r + this.cooldownMs;
    return until > now ? until : null;
  }

  /**
   * The person (instance) a new event should be stored with, or null (top-level session, untracked name,
   * or no person left under the cap of 99). Read-only; apply() records it.
   *  - A continued agent (already known, stopped or not) returns to its person if that person is not
   *    busy with another agent, ignoring the rest.
   *  - Otherwise the lowest free person who is not resting; if every free person is resting, the one
   *    who has rested longest; if the whole pool is busy, `extra-<n>`.
   */
  assign(ev, now = Date.now()) {
    if (!this.isPooled(ev)) return null;
    const key = ev.session_id;
    const w = this.workers.get(key);
    if (w && now - w.last_ts <= RESUME_MS && !this._busy(w.person, now, key)) return w.person;
    let rested = null;
    for (const name of this.names) {
      if (this._busy(name, now, key)) continue;
      if (this._cooldownUntil(name, now) === null) return name;
      const at = this._releasedAt(name, now);
      if (rested === null || at < rested.at) rested = { name, at };
    }
    if (rested) return rested.name;
    for (let n = 1; this.names.length + n <= MAX_PEOPLE; n++) {
      if (!this._busy(`extra-${n}`, now, key)) return `extra-${n}`;
    }
    return null;
  }

  _track(ev, person) {
    let w = this.workers.get(ev.session_id);
    if (!w) {
      w = { person, role: ev.agent, last_ts: -Infinity, stopped: false, stop_ts: null };
      this.workers.set(ev.session_id, w);
    }
    if (ev.ts >= w.last_ts) {
      w.person = person;
      w.role = ev.agent;
      w.last_ts = ev.ts;
      w.stopped = ev.type === 'subagent_stop';
      w.stop_ts = w.stopped ? ev.ts : null;
    }
  }

  /** Forget agents past the resume window, keeping when their person was released. */
  _sweepWorkers(now) {
    for (const [key, w] of this.workers) {
      if (now - w.last_ts <= RESUME_MS) continue;
      const at = w.stopped ? w.stop_ts : w.last_ts + this.staleMs;
      if (at > (this.released.get(w.person) ?? -Infinity)) this.released.set(w.person, at);
      this.workers.delete(key);
    }
    if (this.workers.size > MAX_MAPPINGS) {
      const byAge = [...this.workers].sort((x, y) => x[1].last_ts - y[1].last_ts);
      for (const [key] of byAge.slice(0, this.workers.size - MAX_MAPPINGS)) this.workers.delete(key);
    }
  }

  /** The card an applied event belongs to, or null (a subagent event without a person gets no card). */
  cardFor(ev) {
    if (agentPart(ev.session_id) === null) return this._get(ev.agent);
    return typeof ev.instance === 'string' && ev.instance ? this._get(ev.instance, ev.agent, true) : null;
  }

  apply(ev) {
    if (ev.type === 'pipeline') return null; // pipeline events feed PipelineTracker only
    if (UNTRACKED_AGENTS.includes(ev.agent)) return null; // untracked names never get a card
    const a = this.cardFor(ev); // replay trusts the stored person and never reassigns
    if (!a) return null;
    const person = agentPart(ev.session_id) !== null;
    const isNewAgent = person && !this.workers.has(ev.session_id);
    if (isNewAgent) {
      const h = detectHandoff(this.lastStop, { person: a.id, role: ev.agent, ts: ev.ts }, this.handoffMs);
      if (h) {
        a.handoff = h;
        const giver = this.agents.get(h.from);
        if (giver) giver.handoff = h;
      }
    }
    if (person) this._track(ev, a.id);
    if (person && ev.type === 'subagent_stop' && (!this.lastStop || ev.ts >= this.lastStop.ts)) {
      this.lastStop = { person: a.id, role: ev.agent, ts: ev.ts };
    }
    const prevTs = a.last_event_ts;
    const inOrder = prevTs === null || ev.ts >= prevTs;

    const prevEffective = this._effective(a, ev.ts);
    const startsRun = ACTIVITY.has(ev.type) || ev.type === 'notification';
    if (inOrder && startsRun && (isNewAgent || prevEffective === 'idle' || prevEffective === 'done')) {
      a.run = newTotals();
      a.run_started_ts = ev.ts;
      a.current_task = null;
    }

    // Token / cost increments (events carry deltas).
    const dIn = ev.tokens_in || 0;
    const dOut = ev.tokens_out || 0;
    const dCost = ev.cost_usd || 0;
    a.run.tokens_in += dIn;
    a.run.tokens_out += dOut;
    a.run.cost_usd += dCost;
    a.run.unpriced_tokens += ev.unpriced_tokens || 0;
    const day = utcDay(ev.ts);
    if (a.today_day !== day) {
      if (a.today_day === null || day > a.today_day) {
        a.today = newTotals();
        a.today_day = day;
      }
    }
    if (day === a.today_day) {
      a.today.tokens_in += dIn;
      a.today.tokens_out += dOut;
      a.today.cost_usd += dCost;
      a.today.unpriced_tokens += ev.unpriced_tokens || 0;
    }

    if (inOrder) {
      a.agent = ev.agent; // the person's current role
      let next = a.raw_status;
      if (ACTIVITY.has(ev.type)) {
        next = 'working';
        const explicit = ev.meta && STATUSES.includes(ev.meta.state) ? ev.meta.state : null;
        if (ev.type === 'status' && explicit) next = explicit;
      } else if (ev.type === 'notification') next = 'blocked';
      else if (ev.type === 'stop' || ev.type === 'subagent_stop') next = 'done';
      if (next !== a.raw_status || a.since === null) a.since = ev.ts;
      a.raw_status = next;
      a.last_event_ts = ev.ts;
      if (ev.task) a.current_task = ev.task;
      if (ev.summary) a.last_summary = ev.summary;
      if (ev.tool) a.last_tool = ev.tool;
      a.session_id = ev.session_id;
      if (ev.repo) a.repo = ev.repo;
      if (ev.branch) a.branch = ev.branch;
    }
    return a;
  }

  _effective(a, now) {
    if (a.last_event_ts === null) return 'idle';
    const age = now - a.last_event_ts;
    if (a.raw_status === 'done' && age > this.doneToIdleMs) return 'idle';
    if (a.raw_status === 'working' && age > this.staleMs) return 'idle';
    return a.raw_status;
  }

  /** 1-based pool position of a person (extras follow the pool), or null for a role card. */
  slotOf(a) {
    if (!a.person) return null;
    const i = this.names.indexOf(a.id);
    if (i >= 0) return i + 1;
    const m = EXTRA_RE.exec(a.id);
    return this.names.length + (m ? Number(m[1]) : 1);
  }

  _isPerson(a) {
    return a.person;
  }

  view(a, now) {
    const base = this._effective(a, now);
    const stale = a.raw_status === 'working' && base === 'idle';
    const keepRun = base !== 'idle';
    const sameDay = a.today_day === utcDay(now);
    const person = this._isPerson(a);
    const cooldown = person ? this._cooldownUntil(a.id, now) : null;
    const status = cooldown !== null && base !== 'working' && base !== 'blocked' ? 'resting' : base;
    const extra = EXTRA_RE.exec(a.id);
    const name = !person ? null : extra ? `Extra ${extra[1]}` : a.id;
    const h = a.handoff && now - a.handoff.at <= HANDOFF_SHOW_MS ? a.handoff : null;
    return {
      id: a.id,
      agent: a.agent,
      role: a.agent,
      name,
      label: name ?? this.displayNames[a.id] ?? a.agent,
      slot: person ? this.slotOf(a) : null,
      cooldown_until: cooldown,
      handoff: h,
      status,
      stale,
      current_task: keepRun || stale ? a.current_task : null,
      since: base === 'idle' && a.last_event_ts ? Math.min(now, this._idleSince(a, stale)) : a.since,
      run_started_ts: keepRun ? a.run_started_ts : null,
      last_event_ts: a.last_event_ts,
      last_summary: a.last_summary,
      last_tool: a.last_tool,
      repo: a.repo,
      branch: a.branch,
      tokens: { in: a.run.tokens_in, out: a.run.tokens_out },
      cost_usd: round(a.run.cost_usd),
      unpriced_tokens: a.run.unpriced_tokens,
      today: {
        tokens: { in: sameDay ? a.today.tokens_in : 0, out: sameDay ? a.today.tokens_out : 0 },
        cost_usd: sameDay ? round(a.today.cost_usd) : 0,
        unpriced_tokens: sameDay ? a.today.unpriced_tokens : 0,
      },
    };
  }

  _idleSince(a, stale) {
    return stale ? a.last_event_ts + this.staleMs : a.last_event_ts + this.doneToIdleMs;
  }

  /**
   * Housekeeping: forget old agents and remove transient people (`extra-<n>`, or a name no longer in
   * the pool) once they are idle. Pool people and role cards are never removed. Returns removed ids.
   */
  retire(now = Date.now()) {
    this._sweepWorkers(now);
    const out = [];
    for (const [id, a] of this.agents) {
      if (!a.person || this.names.includes(id) || a.last_event_ts === null) continue;
      if (this._effective(a, now) !== 'idle' || this._busy(id, now)) continue;
      this.agents.delete(id);
      out.push(id);
    }
    return out;
  }

  /** Role cards first (configured ones in order), then people in pool order, extras last. */
  snapshot(now = Date.now()) {
    const roles = this.configured.filter((n) => !UNTRACKED_AGENTS.includes(n));
    const people = [];
    for (const a of this.agents.values()) {
      if (this._isPerson(a)) people.push(a);
      else if (!roles.includes(a.id)) roles.push(a.id);
    }
    people.sort((x, y) => this.slotOf(x) - this.slotOf(y) || (x.id < y.id ? -1 : 1));
    return [...roles.map((n) => this.view(this._get(n), now)), ...people.map((a) => this.view(a, now))];
  }
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------- pipeline

const STEPS = ['spec', 'code', 'verify', 'review', 'user-approval', 'merge', 'deploy', 'cleanup'];
// Gate work done inside the verify / review agents: substeps of a stepper step, never steps.
const SUBSTEPS = { verify: ['test', 'styling'], review: ['security', 'code-review'] };
const GATES = ['test', 'styling', 'security', 'code-review'];
const SUBSTEP_PARENT = { test: 'verify', styling: 'verify', security: 'review', 'code-review': 'review' };
const STEP_STATES = ['pending', 'active', 'passed', 'failed'];
const KINDS = ['feature', 'question', 'server_task', 'single_role'];
const ROLES = ['spec', 'code', 'test', 'security', 'styling', 'code-review', 'cleanup', 'verify', 'review'];
const MAX_ACTIVE_STEPS = 50;
// Panel list (`runs` in the snapshot): at most MAX_PANELS feature runs; finished runs stay for the grace period.
const MAX_PANELS = 8;
const PANEL_GRACE_MINUTES = 10;
// Abandoned runs stay in the panel list this long, measured from the last event (not from when flagged).
const PANEL_ABANDONED_MINUTES = 120;
const ACTIVITY_STATES = ['active', 'passed', 'failed'];
const MAX_ACTIVITY = 20;
const DEPLOY_RESULTS = ['success', 'failure_rolled_back', 'failure_rollback_failed'];

function normalizeDeploy(v) {
  if (typeof v !== 'string') return null;
  const n = v.toLowerCase().replace(/[+\s-]+/g, '_');
  return DEPLOY_RESULTS.includes(n) ? n : null;
}

class PipelineTracker {
  constructor({ maxAttempts = 3, maxRuns = 50, staleMinutes = 60 } = {}) {
    this.maxAttempts = maxAttempts;
    this.staleMs = staleMinutes * 60 * 1000;
    this.maxRuns = maxRuns;
    this.runs = new Map();
    this.currentId = null;
  }

  apply(ev) {
    if (ev.type !== 'pipeline') return null;
    const m = ev.meta || {};
    const id = typeof m.run_id === 'string' && m.run_id ? m.run_id : 'default';
    let run = this.runs.get(id);
    // A run's kind is fixed by its first event; missing or unknown kinds are features.
    const kind = run ? run.kind : KINDS.includes(m.kind) ? m.kind : 'feature';
    if (!run) {
      run =
        kind === 'feature'
          ? {
              run_id: id,
              kind,
              repo: null,
              branch: null,
              pr_url: null,
              commit_sha: null,
              attempt: 1,
              failed_gate: null,
              last_failure: null,
              deploy_result: null,
              started_ts: ev.ts,
              updated_ts: ev.ts,
              steps: {},
            }
          : {
              run_id: id,
              kind,
              target: null,
              role: null,
              substep: null,
              summary: null,
              state: 'active',
              start_seen: false,
              started_ts: ev.ts,
              ended_ts: null,
              updated_ts: ev.ts,
            };
      this.runs.set(id, run);
      // Bound memory: evict the least recently updated runs beyond the cap.
      while (this.runs.size > this.maxRuns) {
        let oldest = null;
        for (const r of this.runs.values()) {
          // Only the new run and the current run are protected. The default cap (50) is far above
          // the panel cap (8), so with the default a panel is only evicted after 42 newer-updated runs.
          if (
            r.run_id !== id &&
            r.run_id !== this.currentId &&
            (oldest === null || r.updated_ts < oldest.updated_ts)
          )
            oldest = r;
        }
        if (!oldest) break;
        this.runs.delete(oldest.run_id);
      }
    }
    if (kind !== 'feature') return this._applyActivity(run, ev, m);
    this.currentId = id;
    run.updated_ts = Math.max(run.updated_ts, ev.ts);
    for (const k of ['repo', 'branch']) {
      const v = m[k] ?? ev[k];
      if (typeof v === 'string' && v) run[k] = v.slice(0, 200);
    }
    for (const k of ['pr_url', 'commit_sha']) {
      if (typeof m[k] === 'string' && m[k]) run[k] = m[k].slice(0, 300);
    }
    if (Number.isFinite(m.attempt) && m.attempt >= 1)
      run.attempt = Math.max(run.attempt, Math.floor(m.attempt));

    // Legacy gate names (`--step test`) are normalised to parent + substep; an invalid substep is dropped.
    let step = STEPS.includes(m.step) ? m.step : null;
    let substep = null;
    if (typeof m.step === 'string' && Object.hasOwn(SUBSTEP_PARENT, m.step)) {
      step = SUBSTEP_PARENT[m.step];
      substep = m.step;
    } else if (step && typeof m.substep === 'string' && (SUBSTEPS[step] || []).includes(m.substep)) {
      substep = m.substep;
    }
    const deploy = normalizeDeploy(m.deploy_result);
    let state = STEP_STATES.includes(m.state) ? m.state : null;
    if (deploy) {
      run.deploy_result = deploy;
      if (!state) state = deploy === 'success' ? 'passed' : 'failed';
    }
    if (step && state && substep) {
      const parent =
        run.steps[step] || (run.steps[step] = { state: 'pending', ts: ev.ts, summary: null, substeps: {} });
      const prev = parent.substeps[substep];
      // An older event for the same substep is ignored; equal ts applies in arrival order.
      if (!prev || ev.ts >= prev.ts) {
        parent.substeps[substep] = { state, ts: ev.ts, summary: ev.summary || null };
        parent.ts = Math.max(parent.ts, ev.ts);
        if (state === 'failed') {
          run.failed_gate = substep;
          run.last_failure = ev.summary || null;
        }
      }
    } else if (step && state) {
      const idx = STEPS.indexOf(step);
      if (state === 'active') {
        // A step restarting (e.g. code after a failed gate) invalidates everything after it.
        for (const later of STEPS.slice(idx + 1)) {
          const l = run.steps[later];
          if (l && (l.state !== 'pending' || Object.keys(l.substeps).length)) {
            run.steps[later] = { state: 'pending', ts: ev.ts, summary: null, substeps: {} };
          }
        }
        if (idx < STEPS.indexOf('deploy')) run.deploy_result = null;
      }
      const prevSubs = state === 'active' ? {} : (run.steps[step] && run.steps[step].substeps) || {};
      run.steps[step] = { state, ts: ev.ts, summary: ev.summary || null, substeps: prevSubs };
      if (state === 'failed') {
        run.failed_gate = typeof m.failed_gate === 'string' ? m.failed_gate.slice(0, 40) : step;
        run.last_failure = ev.summary || null;
      }
    }
    return run;
  }

  /** Non-feature runs: one generic row with a start, a state and an end. Never touches the stepper. */
  _applyActivity(run, ev, m) {
    const state = ACTIVITY_STATES.includes(m.state) ? m.state : null;
    run.updated_ts = Math.max(run.updated_ts, ev.ts);
    const target = m.target ?? ev.repo;
    if (typeof target === 'string' && target) run.target = target.slice(0, 100);
    if (run.kind === 'single_role' && ROLES.includes(m.step)) {
      run.role = m.step;
      run.substep = Object.hasOwn(SUBSTEP_PARENT, m.step)
        ? m.step
        : state && (SUBSTEPS[m.step] || []).includes(m.substep)
          ? m.substep
          : null;
    }
    if (state === 'active') {
      // An active event that is not newer than the recorded end is out of order: keep the end.
      if (run.ended_ts !== null && ev.ts <= run.ended_ts) {
        if (!run.start_seen) {
          run.started_ts = Math.min(run.started_ts, ev.ts);
          run.start_seen = true;
          if (ev.summary && !run.summary) run.summary = ev.summary;
        }
        return run;
      }
      run.started_ts = run.start_seen ? Math.min(run.started_ts, ev.ts) : ev.ts;
      run.start_seen = true;
      run.state = 'active';
      run.ended_ts = null;
      if (ev.summary) run.summary = ev.summary;
    } else if (state) {
      run.state = state;
      run.ended_ts = run.ended_ts === null ? ev.ts : Math.max(run.ended_ts, ev.ts);
      if (!run.start_seen) run.started_ts = Math.min(run.started_ts, ev.ts);
      if (ev.summary) run.summary = ev.summary;
    } else if (ev.summary && !run.summary) {
      run.summary = ev.summary;
    }
    return run;
  }

  /** True when `ts` is older than the pipeline staleness threshold at `now` (strict, like step-map). */
  _stale(ts, now) {
    return Number.isFinite(ts) && now - ts > this.staleMs;
  }

  /** Newest `ts` of a step and its substeps. */
  _stepTs(s) {
    let t = s.ts;
    for (const x of Object.values(s.substeps || {})) t = Math.max(t, x.ts);
    return t;
  }

  /**
   * A step is abandoned when it is derived `active` and silent for too long. The user-approval gate
   * (a human wait) and finished (complete / failed) runs are never abandoned by age.
   */
  _stepAbandoned(run, name, derivedState, now, status) {
    if (derivedState !== 'active' || name === 'user-approval') return false;
    if (status === 'complete' || status === 'failed') return false;
    const s = run.steps[name];
    return !!s && this._stale(this._stepTs(s), now);
  }

  activityView(run, now = Date.now()) {
    const abandoned = run.state === 'active' && this._stale(run.updated_ts, now);
    return {
      run_id: run.run_id,
      kind: run.kind,
      target: run.target,
      role: run.role,
      summary: run.summary,
      state: abandoned ? 'abandoned' : run.state,
      ...(abandoned ? { abandoned: true, stale_since_ts: run.updated_ts } : {}),
      started_ts: run.started_ts,
      ended_ts: run.ended_ts,
      updated_ts: run.updated_ts,
    };
  }

  /** Displayed state of a step: substeps and later steps feed the parents (verify, review). */
  derive(run, name) {
    const s = run.steps[name];
    if (!s) return 'pending';
    const subs = Object.values(s.substeps || {});
    if (!subs.length) return s.state;
    if (subs.some((x) => x.state === 'failed')) return 'failed';
    if (s.state === 'passed' || s.state === 'failed') return s.state;
    if (subs.some((x) => x.state === 'active')) return 'active';
    if (subs.every((x) => x.state === 'passed')) {
      const later = STEPS.slice(STEPS.indexOf(name) + 1);
      if (later.some((n) => ['active', 'passed'].includes(this.derive(run, n)))) return 'passed';
    }
    return 'active';
  }

  _status(run, now = Date.now()) {
    const st = (s) => this.derive(run, s);
    if (st('cleanup') === 'passed') return 'complete';
    if (st('deploy') === 'failed') return 'failed';
    const gateFailed = ['spec', 'code', 'verify', 'review'].some((s) => st(s) === 'failed');
    if (gateFailed && run.attempt >= this.maxAttempts) return 'failed';
    if (st('user-approval') === 'active') return 'waiting_approval';
    return this._stale(run.updated_ts, now) ? 'abandoned' : 'running';
  }

  view(run, now = Date.now()) {
    const derived = Object.fromEntries(STEPS.map((n) => [n, this.derive(run, n)]));
    const status = this._status(run, now);
    return {
      run_id: run.run_id,
      kind: 'feature',
      status,
      ...(status === 'abandoned' ? { abandoned: true } : {}),
      waiting_on_user_approval: run.steps['user-approval']?.state === 'active',
      repo: run.repo,
      branch: run.branch,
      pr_url: run.pr_url,
      commit_sha: run.commit_sha,
      attempt: run.attempt,
      max_attempts: this.maxAttempts,
      failed_gate: run.failed_gate,
      last_failure: run.last_failure,
      deploy_result: run.deploy_result,
      started_ts: run.started_ts,
      updated_ts: run.updated_ts,
      steps: STEPS.map((name) => {
        const s = run.steps[name];
        const stepAb = this._stepAbandoned(run, name, derived[name], now, status);
        return {
          name,
          state: derived[name],
          ...(stepAb ? { abandoned: true } : {}),
          ts: s ? s.ts : null,
          summary: s ? s.summary : null,
          substeps: (SUBSTEPS[name] || []).map((n) => {
            const x = s && s.substeps[n];
            return {
              name: n,
              // A substep never reported under a passed parent was not run: skipped, not pending.
              state: x ? x.state : derived[name] === 'passed' ? 'skipped' : 'pending',
              ...(stepAb && x && x.state === 'active' ? { abandoned: true } : {}),
              ts: x ? x.ts : null,
              summary: x ? x.summary : null,
            };
          }),
        };
      }),
    };
  }

  /**
   * Every step that is `active` right now (derived): across all tracked feature runs, plus active
   * single_role runs (the role is the step). Only ids, repo, step, substep, ts and attempt; bounded.
   */
  activeSteps(now = Date.now()) {
    const out = [];
    for (const r of this.runs.values()) {
      if (r.kind === 'feature') {
        for (const step of STEPS) {
          const d = this.derive(r, step);
          if (d !== 'active') continue;
          if (this._stepAbandoned(r, step, d, now, this._status(r, now))) continue;
          const s = r.steps[step];
          const act = Object.entries(s.substeps || {})
            .filter(([, x]) => x.state === 'active')
            .sort((a, b) => b[1].ts - a[1].ts || SUBSTEPS[step].indexOf(b[0]) - SUBSTEPS[step].indexOf(a[0]));
          // Active only because substeps were seen (a legacy run between gates): nothing is running.
          if (!act.length && s.state !== 'active') continue;
          out.push({
            run_id: r.run_id,
            repo: r.repo,
            step,
            substep: act.length ? act[0][0] : null,
            ts: act.length ? act[0][1].ts : s.ts,
            attempt: r.attempt,
          });
        }
      } else if (
        r.kind === 'single_role' &&
        r.state === 'active' &&
        r.role &&
        !this._stale(r.updated_ts, now)
      ) {
        const step = SUBSTEP_PARENT[r.role] || r.role;
        out.push({
          run_id: r.run_id,
          repo: r.target,
          step,
          substep: r.substep || null,
          ts: r.updated_ts,
          attempt: 1,
        });
      }
    }
    return out.sort((a, b) => b.ts - a.ts || (a.run_id < b.run_id ? -1 : 1)).slice(0, MAX_ACTIVE_STEPS);
  }

  /**
   * Feature runs shown as panels: running, waiting or abandoned runs, plus finished (complete / failed)
   * runs inside the grace window. Capped at MAX_PANELS (most recently updated kept), ordered by
   * started_ts then run_id so panels do not reorder between updates. Applied on read; nothing is rewritten.
   */
  panelRuns(now = Date.now()) {
    const graceMs = PANEL_GRACE_MINUTES * 60 * 1000;
    const abandonedMs = PANEL_ABANDONED_MINUTES * 60 * 1000;
    const eligible = [...this.runs.values()].filter((r) => {
      if (r.kind !== 'feature') return false;
      const status = this._status(r, now);
      if (status === 'complete' || status === 'failed') return now - r.updated_ts <= graceMs;
      if (status === 'abandoned') return now - r.updated_ts <= abandonedMs;
      return true;
    });
    return eligible
      .sort((a, b) => b.updated_ts - a.updated_ts || (a.run_id < b.run_id ? -1 : 1))
      .slice(0, MAX_PANELS)
      .sort(
        (a, b) => a.started_ts - b.started_ts || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0),
      );
  }

  snapshot(now = Date.now()) {
    const run = this.currentId ? this.runs.get(this.currentId) : null;
    const all = [...this.runs.values()].sort((a, b) => b.updated_ts - a.updated_ts);
    const recent = all.slice(0, 5).map((r) => ({
      run_id: r.run_id,
      kind: r.kind,
      status: r.kind === 'feature' ? this._status(r, now) : this.activityView(r, now).state,
      repo: r.kind === 'feature' ? r.repo : r.target,
      updated_ts: r.updated_ts,
    }));
    const activity = all
      .filter((r) => r.kind !== 'feature')
      .slice(0, MAX_ACTIVITY)
      .map((r) => this.activityView(r, now));
    return {
      run: run ? this.view(run, now) : null,
      runs: this.panelRuns(now).map((r) => this.view(r, now)),
      recent_runs: recent,
      activity_runs: activity,
      active_steps: this.activeSteps(now),
    };
  }
}

module.exports = {
  RETIRED_AGENTS,
  UNTRACKED_AGENTS,
  AgentTracker,
  PipelineTracker,
  PANEL_GRACE_MINUTES,
  PANEL_ABANDONED_MINUTES,
  MAX_PANELS,
  STATUSES,
  VIEW_STATUSES,
  STEPS,
  SUBSTEPS,
  GATES,
  KINDS,
  ROLES,
};
