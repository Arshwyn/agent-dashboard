// Idle behaviours of the office: what an agent does at each kind of spot, and the scheduler that
// picks the next activity. Pure (no DOM, no timers): randomness is injected so everything is
// deterministic under test. The sim (agent.js), the renderer and the tests all read this table.
//
// A step is { state, secs: [lo, hi], chance? }. Steps play in order at the spot; a step with a
// `chance` below 1 is rolled once when the activity starts, and when the roll fails the previous
// step simply lasts for that step's duration as well ("stays sat for the whole dwell").

export const WANDER = 'wander'; // no spot: stand somewhere in a zone

export const BEHAVIOURS = {
  beanbag: {
    weight: 3,
    steps: [
      { state: 'sit', secs: [3, 6] },
      { state: 'sleep', secs: [10, 25], chance: 0.6 },
    ],
  },
  coffee: {
    weight: 3,
    steps: [
      { state: 'idle', secs: [1, 2] },
      { state: 'drink', secs: [5, 9] },
    ],
  },
  whiteboard: { weight: 2, steps: [{ state: 'study', secs: [6, 12] }] },
  server: { weight: 1.5, steps: [{ state: 'check', secs: [4, 8] }] },
  window: { weight: 2, steps: [{ state: 'look', secs: [6, 14] }] },
  plant: { weight: 2, steps: [{ state: 'water', secs: [5, 9] }] },
  [WANDER]: {
    weight: 1.5,
    steps: [
      { state: 'stretch', secs: [2, 3] },
      { state: 'idle', secs: [1, 3] },
    ],
  },
};

// Scheduler tuning, exported so tests and tuning share the numbers.
export const REPEAT_LAST_FACTOR = 0.25; // the kind the agent just did
export const REPEAT_RECENT_FACTOR = 0.6; // one of its last RECENT_KINDS kinds
export const RECENT_KINDS = 3;
export const HERD_FACTOR = 0.5; // weight is divided by 1 + HERD_FACTOR * occupants

export const IDLE_STATES = ['idle', 'sit', 'sleep', 'drink', 'study', 'check', 'look', 'water', 'stretch'];

// Every activity state an agent can publish besides the work ones.
export const ACTIVITY_STATES = [
  ...new Set(Object.values(BEHAVIOURS).flatMap((b) => b.steps.map((s) => s.state))),
];

const between = (rng, [lo, hi]) => lo + rng() * (hi - lo);

// Rolls an activity into concrete steps [{ state, secs }]: chances are decided and durations drawn.
export function resolveSteps(kind, rng) {
  const spec = BEHAVIOURS[Object.hasOwn(BEHAVIOURS, kind) ? kind : WANDER];
  const out = [];
  for (const step of spec.steps) {
    const secs = between(rng, step.secs);
    if (step.chance !== undefined && out.length && rng() >= step.chance) out[out.length - 1].secs += secs;
    else out.push({ state: step.state, secs });
  }
  return out;
}

export function weightedPick(items, weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

// Chooses the agent's next activity.
//   freeSpots  the free spots to choose from (a `desk` among them is ignored)
//   occupancy  (zoneId) -> number of OTHER agents in, or walking to, that zone
//   recent     the agent's last kinds, oldest first (defaults to agent.lastKinds)
// Returns { kind, spot } for a spot kind, or { kind: 'wander' } (the caller picks the tile).
export function chooseNext({ agent = null, freeSpots, occupancy = () => 0, rng, recent }) {
  const last = recent || (agent && agent.lastKinds) || [];
  const byKind = new Map();
  for (const s of freeSpots) {
    if (s.kind === 'desk' || !Object.hasOwn(BEHAVIOURS, s.kind) || s.kind === WANDER) continue;
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s);
  }
  const minOcc = (spots) => Math.min(...spots.map((s) => occupancy(s.zone)));
  const kinds = [...byKind.keys(), WANDER];
  const weights = kinds.map((kind) => {
    let w = BEHAVIOURS[kind].weight;
    if (last.length && last[last.length - 1] === kind) w *= REPEAT_LAST_FACTOR;
    else if (last.slice(-RECENT_KINDS).includes(kind)) w *= REPEAT_RECENT_FACTOR;
    const occ = kind === WANDER ? 0 : minOcc(byKind.get(kind));
    return w / (1 + HERD_FACTOR * occ);
  });
  const kind = weightedPick(kinds, weights, rng);
  if (kind === WANDER) return { kind };
  // the free spot of that kind in the least crowded zone; ties by rng
  const spots = byKind.get(kind);
  const best = Math.min(...spots.map((s) => occupancy(s.zone)));
  const pool = spots.filter((s) => occupancy(s.zone) === best);
  return { kind, spot: pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] };
}

// ---- seeded randomness (the `?office-seed=<integer>` test hook) ---------------------------------

// Small deterministic generator (mulberry32): the same integer always gives the same sequence.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The integer in `?office-seed=<n>` of a location.search string, or null when absent or invalid.
export function seedFromSearch(search) {
  const raw = new URLSearchParams(search || '').get('office-seed');
  return raw !== null && /^-?\d{1,15}$/.test(raw) ? Number(raw) : null;
}
