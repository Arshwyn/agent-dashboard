// Client-side store: the ONLY thing that talks to the backend. Views (mission control today,
// maybe a pixel-art skin later) subscribe to it and never touch fetch/EventSource themselves.
//
// state = {
//   connection: 'connecting' | 'live' | 'reconnecting',
//   agents:   [{ id, status: 'idle'|'working'|'blocked'|'done'|'resting', task, since, tokens:{in,out}, ...raw }],
//             id is a person id (a pool name, `extra-<n>`) or a role card; `agent`/`role` is the role they do now (null
//             for a person who never worked), `name`, `label`, `slot` (null for a role card), `cooldown_until`, `handoff`
//   events:   [{ id, ts, agent, type, tool, summary, ... }]   // newest first, bounded
//   pipeline: { run, runs, recent_runs, activity_runs, active_steps }   // runs: one entry per panel (default [run] / []);
//             run is the last-emitting run (header summary); activity_runs: non-feature runs, newest first;
//             run.steps[].substeps: [{ name, state, ts, summary }] (verify, review)
//             run.status may be 'abandoned' (run.abandoned); steps/substeps/activity rows may carry abandoned: true
//             (activity state 'abandoned', stale_since_ts); old servers send neither, so treat a missing flag as false
//             active_steps: [{ run_id, repo, step, substep, ts, attempt }] for every active step (default [])
//   costs:    { days, summary: /api/costs body | null, sessions: /api/sessions list }
// }

// How many sessions the store asks for; the sessions summary shows "N+" when the list is this long.
export const SESSIONS_LIMIT = 50;
export const STATUSES = ['idle', 'working', 'blocked', 'done'];

export function normalizeAgent(a) {
  return { ...a, id: a.id ?? a.agent, task: a.current_task ?? null };
}

// Older servers do not send activity_runs or active_steps; always hand views an array.
function normalizePipeline(p) {
  const q = p && typeof p === 'object' ? p : {};
  const run = q.run ?? null;
  if (run && run.status === 'abandoned') run.abandoned = true;
  // Older servers send no `runs`: the single run is the only panel.
  const list = Array.isArray(q.runs) ? q.runs.filter((r) => r && typeof r === 'object') : run ? [run] : [];
  const runs = list.map((r) => (r.status === 'abandoned' ? { ...r, abandoned: true } : r));
  return {
    ...q,
    run,
    runs,
    recent_runs: Array.isArray(q.recent_runs) ? q.recent_runs : [],
    activity_runs: Array.isArray(q.activity_runs)
      ? q.activity_runs.map((r) => (r.state === 'abandoned' ? { ...r, abandoned: true } : r))
      : [],
    active_steps: Array.isArray(q.active_steps) ? q.active_steps : [],
  };
}

export function createStore({
  fetchFn = fetch.bind(globalThis),
  EventSourceCtor = globalThis.EventSource,
  maxEvents = 200,
  onUnauthorized = () => {},
} = {}) {
  const state = {
    connection: 'connecting',
    agents: [],
    events: [],
    pipeline: { run: null, runs: [], recent_runs: [], activity_runs: [], active_steps: [] },
    costs: { days: 7, summary: null, sessions: [] },
  };
  let costTimer = null;
  let skew = 0;
  let es = null;
  let retryTimer = null;
  const subs = new Set();

  const emit = (what) => subs.forEach((fn) => fn(state, what));

  function upsertAgent(a) {
    const n = normalizeAgent(a);
    const i = state.agents.findIndex((x) => x.id === n.id);
    if (i >= 0) state.agents[i] = n;
    else state.agents.push(n);
  }

  function addEvent(ev) {
    if (state.events.some((e) => e.id === ev.id)) return;
    state.events.push(ev);
    state.events.sort((a, b) => b.id - a.id);
    if (state.events.length > maxEvents) state.events.length = maxEvents;
  }

  async function getJson(url) {
    const r = await fetchFn(url, { credentials: 'same-origin' });
    if (r.status === 401) {
      onUnauthorized();
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function resync() {
    const [a, e, p] = await Promise.all([
      getJson('/api/agents'),
      getJson('/api/events?limit=100'),
      getJson('/api/pipeline'),
    ]);
    skew = a.now - Date.now();
    state.agents = a.agents.map(normalizeAgent);
    state.events = e.events;
    state.pipeline = normalizePipeline(p);
    emit('all');
    await refreshCosts();
  }

  // Costs are derived server-side; refetch them (debounced) when an event carrying usage arrives.
  async function refreshCosts() {
    const days = state.costs.days;
    try {
      const [c, s] = await Promise.all([
        getJson(`/api/costs?days=${days}`),
        getJson(`/api/sessions?limit=${SESSIONS_LIMIT}`),
      ]);
      if (days !== state.costs.days) return; // the period changed while fetching
      state.costs.summary = c && c.total ? c : null;
      state.costs.sessions = Array.isArray(s && s.sessions) ? s.sessions : [];
    } catch {
      return; // older server without the endpoints, or a transient error: keep what we have
    }
    emit('costs');
  }

  function scheduleCostRefresh() {
    clearTimeout(costTimer);
    costTimer = setTimeout(() => refreshCosts(), 1500);
  }

  function setConnection(c) {
    if (state.connection !== c) {
      state.connection = c;
      emit('connection');
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    es = new EventSourceCtor('/api/stream');
    let wasDown = false;
    es.onopen = () => {
      setConnection('live');
      if (wasDown) resync().catch(() => {});
      wasDown = false;
    };
    es.onerror = () => {
      wasDown = true;
      setConnection('reconnecting');
      // EventSource retries by itself (sending Last-Event-ID); if it gave up, restart it.
      if (es.readyState === 2) {
        es.close();
        retryTimer = setTimeout(() => {
          resync().catch(() => {});
          connect();
        }, 3000);
      }
    };
    es.addEventListener('event', (m) => {
      const ev = JSON.parse(m.data);
      addEvent(ev);
      emit('events');
      if (ev.usage || ev.cost_source) scheduleCostRefresh();
    });
    es.addEventListener('agent', (m) => {
      upsertAgent(JSON.parse(m.data));
      emit('agents');
    });
    es.addEventListener('pipeline', (m) => {
      state.pipeline = normalizePipeline(JSON.parse(m.data));
      emit('pipeline');
    });
    es.addEventListener('resync', () => resync().catch(() => {}));
  }

  return {
    state,
    now: () => Date.now() + skew,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    resync,
    refreshCosts,
    setCostDays(days) {
      state.costs.days = days;
      return refreshCosts();
    },
    async start() {
      try {
        await resync();
      } catch {
        /* the stream will resync once it connects */
      }
      connect();
    },
    stop() {
      clearTimeout(retryTimer);
      clearTimeout(costTimer);
      if (es) es.close();
    },
  };
}
