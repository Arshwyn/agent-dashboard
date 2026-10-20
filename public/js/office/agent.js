// Agent simulation: one small state machine per agent, driven by its dashboard status.
// Pure (no DOM, no timers): time only enters through update(dt) / advance(secs) and randomness
// through rng(), so the whole thing is unit-testable. Positions are in tile units (a tile's centre
// is its x, y).
//
//   status            behaviour                                              state when settled
//   idle / stale      scheduler picks an activity at a spot (behaviours.js)   sit sleep idle drink study
//                     or somewhere to stand; walk there, play its steps,      check look water stretch
//                     then pick the next one
//   working           reserve own desk, walk to it, sit                      typing (monitor on)
//   blocked           stay at / return to the desk                           alert  (bubble)
//   done              celebrate where it is, then behave as idle             celebrate -> activity
//
// Under reduced motion nothing walks and idle agents do not cycle activities; only celebrate
// timers and desk waits keep running (see nextWake / advance).

import { buildGrid, findPath } from './grid.js';
import { createSpotRegistry } from './spots.js';
import { spawnOf } from './layout.js';
import { WANDER, HERD_FACTOR, RECENT_KINDS, chooseNext, resolveSteps, weightedPick } from './behaviours.js';

export const STATUSES = ['idle', 'working', 'blocked', 'done', 'resting'];
export const normalizeStatus = (s) => (STATUSES.includes(s) ? s : 'idle');

const DESK_RETRY_SECS = 1;
export const HANDOFF_STAND_SECS = 2; // the giver of a handoff stands beside the receiver this long

export function createSim({
  layout,
  rng = Math.random,
  speed = 3, // tiles per second
  celebrateSecs = 3,
  teleport = false,
}) {
  const grid = buildGrid(layout);
  const spots = createSpotRegistry(layout.spots);
  const spawn = spawnOf(layout, grid);
  const agents = new Map();
  const spotTiles = new Set(layout.spots.map((s) => `${s.x},${s.y}`));
  let reduced = teleport;

  const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

  const zoneAt = (t) =>
    layout.zones.find(
      (z) => t.x >= z.rect.x && t.x < z.rect.x + z.rect.w && t.y >= z.rect.y && t.y < z.rect.y + z.rect.h,
    ) || null;
  // The zone an agent is in, or walking to (its spot's zone while it holds a spot).
  function zoneOf(a) {
    const held = spots.spotOf(a.id);
    const z = held ? { id: held.zone } : zoneAt(a.dest || a.tile);
    return z ? z.id : null;
  }
  function occupancyFor(a) {
    const counts = new Map();
    for (const b of agents.values()) {
      if (b === a) continue;
      const z = zoneOf(b);
      if (z) counts.set(z, (counts.get(z) || 0) + 1);
    }
    return (zone) => counts.get(zone) || 0;
  }

  function snapTo(a, tile) {
    a.tile = { x: tile.x, y: tile.y };
    a.x = tile.x;
    a.y = tile.y;
    a.dest = { x: tile.x, y: tile.y };
    a.path = [];
  }

  // A walkable tile for standing about: a zone weighted against crowding, not a spot tile, not the
  // agent's own, and (best effort) not next to another agent's tile or target.
  function wanderTile(a, occupancy, preferZone) {
    const others = [];
    for (const b of agents.values()) if (b !== a) others.push(b.tile, b.dest || b.tile);
    const near = (x, y) => others.some((t) => Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) <= 1);
    const tilesIn = (z) => {
      const out = [];
      for (let y = z.rect.y; y < z.rect.y + z.rect.h; y++) {
        for (let x = z.rect.x; x < z.rect.x + z.rect.w; x++) {
          if (grid.isWalkable(x, y) && !spotTiles.has(`${x},${y}`) && (x !== a.tile.x || y !== a.tile.y))
            out.push({ x, y });
        }
      }
      return out;
    };
    const zones = preferZone ? layout.zones.filter((z) => z.id === preferZone) : layout.zones;
    const pool = zones.length ? zones : layout.zones;
    const first = weightedPick(
      pool,
      pool.map((z) => 1 / (1 + HERD_FACTOR * occupancy(z.id))),
      rng,
    );
    for (const z of [first, ...pool.filter((p) => p !== first)]) {
      const tiles = tilesIn(z);
      const apart = tiles.filter((t) => !near(t.x, t.y));
      if (apart.length || tiles.length) return pick(apart.length ? apart : tiles);
    }
    return null;
  }

  // Starts the activity the agent just arrived for: rolls its steps and plays the first.
  function startAct(a) {
    const kind = a.actKind || WANDER;
    const steps = resolveSteps(kind, rng);
    a.act = { kind, steps, stepIndex: 0, timer: steps[0].secs };
    a.state = steps[0].state;
  }

  function settle(a) {
    const spot = spots.spotOf(a.id);
    a.dest = { x: a.tile.x, y: a.tile.y };
    switch (a.arrive) {
      case 'typing':
      case 'alert':
        a.state = a.arrive;
        a.act = null;
        break;
      case 'celebrate':
        a.state = 'celebrate';
        a.act = null;
        a.timer = celebrateSecs;
        break;
      case 'wait':
        a.state = 'idle';
        a.act = null;
        break;
      case 'handoff':
        a.act = {
          kind: 'handoff',
          steps: [{ state: 'idle', secs: HANDOFF_STAND_SECS }],
          stepIndex: 0,
          timer: HANDOFF_STAND_SECS,
        };
        a.state = 'idle';
        break;
      default:
        startAct(a);
    }
    if (spot && a.tile.x === spot.x && a.tile.y === spot.y) a.facing = spot.facing;
  }

  // Walks to `dest` (a tile) and then settles into `arrive`. A walk in progress finishes its
  // current step first, so the character never jumps.
  function goTo(a, dest, arrive) {
    a.arrive = arrive;
    a.dest = { x: dest.x, y: dest.y };
    if (reduced) {
      snapTo(a, dest);
      return settle(a);
    }
    const stepping = a.state === 'walking' && a.path.length > 0;
    const origin = stepping ? a.path[0] : a.tile;
    const route = findPath(grid, origin, dest);
    if (!route) {
      // Unreachable (cannot happen for validated spots): stay put rather than crash.
      a.path = [];
      a.dest = { x: a.tile.x, y: a.tile.y };
      return settle(a);
    }
    a.path = stepping ? [origin, ...route.slice(1)] : route.slice(1);
    if (!a.path.length) return settle(a);
    a.act = null;
    a.state = 'walking';
  }

  // Picks the agent's next activity (a spot to use, or somewhere to stand) and goes there. The old
  // spot is freed atomically when the next one is taken, or at once when the agent just stands.
  function schedule(a, { immediate = false } = {}) {
    a.wandering = true;
    a.waiting = false;
    a.act = null;
    const here = spots.spotOf(a.id);
    if (here && here.kind === 'desk') spots.release(a.id);
    const kept = here && here.kind !== 'desk' ? [here.id] : [];
    const occupancy = occupancyFor(a);
    const choice = chooseNext({
      agent: a,
      freeSpots: spots.freeSpots({ notKind: 'desk', exclude: kept }),
      occupancy,
      rng,
    });
    let kind = choice.kind;
    let spot = null;
    if (choice.spot) spot = spots.reserve({ id: choice.spot.id }, a.id); // null when it raced away
    if (!spot) {
      kind = WANDER;
      spots.release(a.id);
    }
    a.actKind = kind;
    a.lastKinds = [...a.lastKinds, kind].slice(-RECENT_KINDS);
    const dest = spot ? { x: spot.x, y: spot.y } : wanderTile(a, occupancy);
    if (!dest) {
      // nowhere to go: stand where we are
      a.arrive = 'dwell';
      settle(a);
    } else if (immediate) {
      snapTo(a, dest);
      a.arrive = 'dwell';
      settle(a);
    } else goTo(a, dest, 'dwell');
    wakeWaiting();
  }

  function seekDesk(a) {
    const desk = spots.reserveDesk(a.id);
    a.wandering = false;
    a.act = null;
    if (!desk) {
      // More working agents than desks: wait in the workspace and retry; never crash.
      a.waiting = true;
      spots.release(a.id);
      a.retry = DESK_RETRY_SECS;
      const ws = layout.zones.find((z) => z.kind === 'workspace');
      const tile = wanderTile(a, () => 0, ws && ws.id);
      if (tile) goTo(a, tile, 'wait');
      else a.state = 'idle';
      return;
    }
    a.waiting = false;
    const arrive = a.status === 'blocked' ? 'alert' : 'typing';
    if (a.state !== 'walking' && a.tile.x === desk.x && a.tile.y === desk.y) {
      a.arrive = arrive;
      a.facing = desk.facing;
      a.state = arrive;
    } else goTo(a, { x: desk.x, y: desk.y }, arrive);
    wakeWaiting(); // the spot this agent just left may be a desk someone waits for
  }

  // Agents waiting for a desk take one the moment it is free (event-driven; update() also retries).
  function wakeWaiting() {
    for (const a of [...agents.values()]) {
      if (!a.waiting) continue;
      if (!spots.freeSpots({ kind: 'desk' }).length) return;
      seekDesk(a);
    }
  }

  function celebrate(a) {
    a.wandering = false;
    a.waiting = false;
    a.act = null;
    if (a.state === 'walking') {
      a.path = a.path.slice(0, 1); // finish the current step, then celebrate there
      a.arrive = 'celebrate';
    } else {
      a.arrive = 'celebrate';
      settle(a);
    }
    wakeWaiting();
  }

  // `look` is the atlas look key (a person look, a role look or `fallback`), `name` the tag shown on
  // the sprite (null for none). The sim key stays `id`; both are display data only.
  function addAgent(id, look = null, name = null) {
    if (agents.has(id)) return agents.get(id);
    const a = {
      id,
      look,
      name,
      status: 'idle',
      state: 'idle',
      arrive: 'dwell',
      tile: { ...spawn },
      dest: { ...spawn },
      x: spawn.x,
      y: spawn.y,
      path: [],
      facing: 'down',
      timer: 0,
      retry: 0,
      wandering: false,
      waiting: false,
      act: null,
      actKind: null,
      lastKinds: [],
    };
    agents.set(id, a);
    schedule(a, { immediate: true }); // new agents appear in place at a free spot
    return a;
  }

  function removeAgent(id) {
    spots.release(id);
    agents.delete(id);
    wakeWaiting();
  }

  function setStatus(id, status) {
    const a = agents.get(id) || addAgent(id);
    const next = normalizeStatus(status);
    if (a.status === next) return a;
    a.status = next;
    if (next === 'idle' || next === 'resting') {
      if (!a.wandering) schedule(a);
    } else if (next === 'done') celebrate(a);
    else seekDesk(a);
    return a;
  }

  // Back to what the status says, after a short detour (a handoff).
  function resume(a) {
    if (a.status === 'working' || a.status === 'blocked') seekDesk(a);
    else schedule(a);
  }

  // A free walkable tile beside `tile`, not a spot tile and not under another agent. Deterministic.
  function besideTile(tile, giver) {
    const taken = [];
    for (const b of agents.values()) if (b !== giver) taken.push(b.tile, b.dest || b.tile);
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, 1],
      [0, -1],
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      const x = tile.x + dx;
      const y = tile.y + dy;
      if (!grid.isWalkable(x, y) || spotTiles.has(`${x},${y}`)) continue;
      if (taken.some((t) => t.x === x && t.y === y)) continue;
      return { x, y };
    }
    return null;
  }

  // The giver of an inferred handoff walks beside the receiver, stands for HANDOFF_STAND_SECS, then
  // returns to what its status says. Under reduced motion nothing moves (the card text carries it).
  // Returns true when the walk was started.
  function handoff(giverId, receiverId) {
    const g = agents.get(giverId);
    const r = agents.get(receiverId);
    if (!g || !r || g === r || reduced) return false;
    const dest = besideTile(r.dest || r.tile, g);
    if (!dest) return false;
    g.wandering = false;
    g.waiting = false;
    g.act = null;
    goTo(g, dest, 'handoff');
    return true;
  }

  function setTeleport(on) {
    reduced = Boolean(on);
    if (!reduced) return;
    for (const a of agents.values()) {
      if (a.state === 'walking') {
        if (a.path.length) snapTo(a, a.path[a.path.length - 1]);
        settle(a);
      }
    }
  }

  const signature = () =>
    [...agents.values()].map((a) => `${a.id}:${a.state}:${a.tile.x},${a.tile.y}`).join('|');

  // Advances timers by dt seconds. Under reduced motion only the timers that must still run do:
  // the celebrate end and the desk retry. Nothing walks and idle agents hold their pose.
  function tick(dt) {
    for (const a of [...agents.values()]) {
      if (!agents.has(a.id)) continue;
      if (a.state === 'walking') {
        if (!reduced) walk(a, dt);
      } else if (a.state === 'celebrate') {
        a.timer -= dt;
        if (a.timer <= 0) {
          spots.release(a.id);
          schedule(a);
        }
      } else if (a.waiting) {
        a.retry -= dt;
        if (a.retry <= 0) {
          a.retry = DESK_RETRY_SECS;
          if (spots.freeSpots({ kind: 'desk' }).length) seekDesk(a);
        }
      } else if (a.act && !reduced) {
        a.act.timer -= dt;
        while (a.act && a.act.timer <= 0) {
          const next = a.act.stepIndex + 1;
          if (next >= a.act.steps.length) {
            if (a.act.kind === 'handoff') resume(a);
            else schedule(a);
            break;
          }
          const carry = a.act.timer; // negative: time already spent in the next step
          a.act.stepIndex = next;
          a.act.timer = a.act.steps[next].secs + carry;
          a.state = a.act.steps[next].state;
        }
      }
    }
  }

  function update(dt) {
    tick(dt);
  }

  // Runs timers for `secs` of elapsed wall time (used while reduced motion has no frame loop).
  // Returns true when anything visible changed.
  function advance(secs) {
    const before = signature();
    tick(secs);
    return signature() !== before;
  }

  // Seconds until the earliest timer that still has to run under reduced motion (the end of a
  // celebration), or Infinity.
  function nextWake() {
    let wake = Infinity;
    for (const a of agents.values()) if (a.state === 'celebrate') wake = Math.min(wake, Math.max(0, a.timer));
    return wake;
  }

  function walk(a, dt) {
    let left = speed * dt;
    while (left > 0 && a.path.length) {
      const t = a.path[0];
      const dx = t.x - a.x;
      const dy = t.y - a.y;
      const dist = Math.abs(dx) + Math.abs(dy);
      if (Math.abs(dx) >= Math.abs(dy)) a.facing = dx < 0 ? 'left' : 'right';
      if (Math.abs(dy) > Math.abs(dx)) a.facing = dy < 0 ? 'up' : 'down';
      if (dist <= left) {
        left -= dist;
        a.x = t.x;
        a.y = t.y;
        a.tile = { x: t.x, y: t.y };
        a.path.shift();
      } else {
        a.x += Math.sign(dx) * left;
        a.y += Math.sign(dy) * left;
        left = 0;
      }
    }
    if (!a.path.length) settle(a);
  }

  // Spot ids of desks whose monitor is on (their holder is typing).
  function litSpots() {
    const lit = new Set();
    for (const a of agents.values()) {
      if (a.state === 'typing') {
        const s = spots.spotOf(a.id);
        if (s) lit.add(s.id);
      }
    }
    return lit;
  }

  return {
    grid,
    spots,
    spawn,
    agents,
    addAgent,
    removeAgent,
    setStatus,
    handoff,
    setTeleport,
    update,
    advance,
    nextWake,
    litSpots,
    zoneOf,
  };
}
