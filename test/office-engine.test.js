'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gridMod = () => import('../public/js/office/grid.js');
const spotsMod = () => import('../public/js/office/spots.js');
const agentMod = () => import('../public/js/office/agent.js');
const rendererMod = () => import('../public/js/office/renderer.js');
const loopMod = () => import('../public/js/office/loop.js');
const behavioursMod = () => import('../public/js/office/behaviours.js');
const bundled = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'office', 'layout.json'), 'utf8'));

// Deterministic RNG (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A grid from ASCII rows: '#' blocked, anything else open.
async function asciiGrid(rows) {
  const { buildGrid } = await gridMod();
  return buildGrid({
    width: rows[0].length,
    height: rows.length,
    layers: { walls: rows.map((r) => r.replace(/[^#]/g, '.')) },
    props: [],
  });
}

// ---- grid and pathfinding --------------------------------------------------------------------

test('findPath: shortest length on an open map, both ends included', async () => {
  const { findPath } = await gridMod();
  const g = await asciiGrid(['.....', '.....', '.....']);
  const p = findPath(g, { x: 0, y: 0 }, { x: 4, y: 2 });
  assert.equal(p.length, 7); // 6 steps
  assert.deepEqual(p[0], { x: 0, y: 0 });
  assert.deepEqual(p[6], { x: 4, y: 2 });
  for (let i = 1; i < p.length; i++) {
    assert.equal(Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y), 1);
  }
});

test('findPath: routes around walls and never steps on a blocked tile', async () => {
  const { findPath } = await gridMod();
  const g = await asciiGrid(['..#..', '..#..', '..#..', '.....']);
  const p = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(p.length, 1 + 3 + 4 + 3); // down 3, across 4, up 3
  for (const t of p) assert.ok(g.isWalkable(t.x, t.y));
});

test('findPath: unreachable or blocked ends give null, start == goal gives one tile', async () => {
  const { findPath } = await gridMod();
  const g = await asciiGrid(['..#..', '..#..']);
  assert.equal(findPath(g, { x: 0, y: 0 }, { x: 4, y: 1 }), null);
  assert.equal(findPath(g, { x: 0, y: 0 }, { x: 2, y: 0 }), null); // goal is a wall
  assert.equal(findPath(g, { x: 0, y: 0 }, { x: 9, y: 9 }), null); // out of bounds
  assert.deepEqual(findPath(g, { x: 1, y: 1 }, { x: 1, y: 1 }), [{ x: 1, y: 1 }]);
});

test('buildGrid: blocking props block, non-blocking props do not', async () => {
  const { buildGrid } = await gridMod();
  const g = buildGrid({
    width: 4,
    height: 2,
    layers: { walls: ['....', '....'] },
    props: [
      { type: 'table', x: 0, y: 0, w: 2, h: 1, blocking: true },
      { type: 'beanbag', x: 3, y: 1, w: 1, h: 1, blocking: false },
    ],
  });
  assert.equal(g.isWalkable(0, 0), false);
  assert.equal(g.isWalkable(1, 0), false);
  assert.equal(g.isWalkable(3, 1), true);
});

// ---- spot reservation ------------------------------------------------------------------------

const SPOTS = [
  { id: 'a', zone: 'z1', kind: 'desk', x: 0, y: 0, facing: 'up' },
  { id: 'b', zone: 'z1', kind: 'desk', x: 1, y: 0, facing: 'up' },
  { id: 'c', zone: 'z2', kind: 'plant', x: 2, y: 0, facing: 'up' },
];

test('spots: N agents and N spots never double-book, extra agents get null', async () => {
  const { createSpotRegistry } = await spotsMod();
  const reg = createSpotRegistry(SPOTS);
  const got = ['u1', 'u2', 'u3'].map((id) => reg.reserve({}, id).id);
  assert.equal(new Set(got).size, 3);
  assert.equal(reg.reserve({}, 'u4'), null);
  for (const s of SPOTS) assert.ok(reg.holderOf(s.id));
});

test('spots: release frees a spot, is idempotent, and an agent holds at most one', async () => {
  const { createSpotRegistry } = await spotsMod();
  const reg = createSpotRegistry(SPOTS);
  const first = reg.reserve('desk', 'u1');
  assert.equal(reg.reserve('desk', 'u1'), first); // idempotent
  const second = reg.reserve('plant', 'u1'); // switching releases the old one
  assert.equal(second.id, 'c');
  assert.equal(reg.holderOf(first.id), null);
  assert.equal(reg.spotOf('u1').id, 'c');
  assert.equal(reg.release('u1').id, 'c');
  assert.equal(reg.release('u1'), null); // second release is a no-op
  assert.equal(reg.spotOf('u1'), null);
  assert.equal(reg.holderOf('c'), null);
  assert.equal(reg.reserve('plant', 'u2').id, 'c');
});

test('spots: selectors by kind, zone, notKind and exclude; rng picks among the free ones', async () => {
  const { createSpotRegistry } = await spotsMod();
  const reg = createSpotRegistry(SPOTS);
  assert.deepEqual(
    reg.freeSpots({ zone: 'z1' }).map((s) => s.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    reg.freeSpots({ notKind: 'desk' }).map((s) => s.id),
    ['c'],
  );
  assert.deepEqual(
    reg.freeSpots({ kind: 'desk', exclude: ['a'] }).map((s) => s.id),
    ['b'],
  );
  assert.equal(reg.reserve('desk', 'u1', () => 0.99).id, 'b');
});

test('spots: reserveDesk is stable per agent id and never shares', async () => {
  const { createSpotRegistry } = await spotsMod();
  const desks = bundled().spots.filter((s) => s.kind === 'desk');
  const r1 = createSpotRegistry(desks);
  const r2 = createSpotRegistry(desks);
  assert.equal(r1.reserveDesk('code').id, r2.reserveDesk('code').id);
  assert.equal(r1.reserveDesk('code').id, r1.reserveDesk('code').id);
  const r3 = createSpotRegistry(desks);
  const ids = new Set();
  for (let i = 0; i < desks.length; i++) ids.add(r3.reserveDesk(`agent-${i}`).id);
  assert.equal(ids.size, desks.length);
  assert.equal(r3.reserveDesk('one-too-many'), null);
});

// ---- state machine ---------------------------------------------------------------------------

async function sim(opts = {}) {
  const { createSim } = await agentMod();
  return createSim({ layout: bundled(), rng: seeded(7), ...opts });
}

// Advance until `done(a)` or fail after `seconds` of simulated time.
function run(s, seconds, done = () => false) {
  const steps = Math.ceil(seconds / 0.05);
  for (let i = 0; i < steps; i++) {
    if (done()) return true;
    s.update(0.05);
  }
  return done();
}

test('idle: a new agent appears in place and keeps moving between spots and zones', async () => {
  const { IDLE_STATES } = await behavioursMod();
  const s = await sim();
  const a = s.addAgent('ask');
  const first = s.spots.spotOf('ask');
  assert.ok(IDLE_STATES.includes(a.state), a.state);
  assert.notEqual(first?.kind, 'desk');
  if (first) assert.deepEqual(a.tile, { x: first.x, y: first.y });
  const seen = new Set([first ? first.id : 'free']);
  const zones = new Set([s.zoneOf(a)]);
  for (let i = 0; i < 800; i++) {
    s.update(0.25);
    const here = s.spots.spotOf('ask');
    assert.notEqual(here?.kind, 'desk');
    seen.add(here ? here.id : 'free');
    zones.add(s.zoneOf(a));
  }
  assert.ok(seen.size > 3, `only visited ${seen.size} spots`);
  assert.ok(zones.size >= 3, `only visited ${zones.size} zones`);
});

test('idle agents never share a spot', async () => {
  const s = await sim();
  const ids = Array.from({ length: 20 }, (_, i) => `a${i}`);
  ids.forEach((id) => s.addAgent(id));
  for (let i = 0; i < 300; i++) {
    s.update(0.25);
    const held = ids.map((id) => s.spots.spotOf(id)?.id).filter(Boolean);
    assert.equal(new Set(held).size, held.length);
  }
});

test('working: reserves its own stable desk, walks there, sits and turns the monitor on', async () => {
  const s = await sim();
  const a = s.addAgent('code');
  s.setStatus('code', 'working');
  const desk = s.spots.spotOf('code');
  assert.equal(desk.kind, 'desk');
  assert.equal(a.state, 'walking');
  assert.ok(run(s, 120, () => a.state === 'typing'));
  assert.deepEqual(a.tile, { x: desk.x, y: desk.y });
  assert.equal(a.facing, desk.facing);
  assert.ok(s.litSpots().has(desk.id));
  // a second agent gets a different desk; a repeat of the same status changes nothing
  s.addAgent('test');
  s.setStatus('test', 'working');
  assert.notEqual(s.spots.spotOf('test').id, desk.id);
  s.setStatus('code', 'working');
  assert.equal(s.spots.spotOf('code').id, desk.id);
  // the same agent id gets the same desk in a fresh simulation
  const s2 = await sim();
  s2.addAgent('code');
  s2.setStatus('code', 'working');
  assert.equal(s2.spots.spotOf('code').id, desk.id);
});

test('blocked: stays at the desk with the alert state and the monitor off', async () => {
  const s = await sim();
  const a = s.addAgent('security');
  s.setStatus('security', 'working');
  run(s, 120, () => a.state === 'typing');
  const desk = s.spots.spotOf('security');
  s.setStatus('security', 'blocked');
  assert.equal(a.state, 'alert');
  assert.deepEqual(a.tile, { x: desk.x, y: desk.y });
  assert.equal(s.litSpots().size, 0);
  run(s, 10);
  assert.equal(a.state, 'alert');
  // blocked straight from idle walks to the desk and alerts there
  const b = s.addAgent('styling');
  s.setStatus('styling', 'blocked');
  assert.ok(run(s, 120, () => b.state === 'alert'));
  assert.equal(s.spots.spotOf('styling').kind, 'desk');
});

test('done: celebrates where it is, then returns to idle behaviour and frees the desk', async () => {
  const s = await sim();
  const a = s.addAgent('cleanup');
  s.setStatus('cleanup', 'working');
  run(s, 120, () => a.state === 'typing');
  const desk = s.spots.spotOf('cleanup');
  s.setStatus('cleanup', 'done');
  assert.equal(a.state, 'celebrate');
  assert.deepEqual(a.tile, { x: desk.x, y: desk.y });
  assert.equal(s.spots.spotOf('cleanup').id, desk.id); // desk kept while celebrating
  assert.ok(run(s, 10, () => a.state !== 'celebrate'));
  assert.ok(run(s, 120, () => s.spots.spotOf('cleanup')?.kind !== 'desk'));
  assert.notEqual(s.spots.spotOf('cleanup')?.kind, 'desk');
  // the server then reports idle: nothing restarts
  const before = s.spots.spotOf('cleanup')?.id;
  s.setStatus('cleanup', 'idle');
  assert.equal(s.spots.spotOf('cleanup')?.id, before);
});

test('idle and unknown statuses (stale is mapped to idle by the view) wander to non-desk spots', async () => {
  const { normalizeStatus } = await agentMod();
  assert.equal(normalizeStatus('stale'), 'idle');
  assert.equal(normalizeStatus(undefined), 'idle');
  assert.equal(normalizeStatus('working'), 'working');
  const s = await sim();
  const a = s.addAgent('spec');
  s.setStatus('spec', 'working');
  run(s, 120, () => a.state === 'typing');
  s.setStatus('spec', 'weird-status');
  assert.equal(a.status, 'idle');
  assert.ok(run(s, 120, () => a.state === 'idle' && s.spots.spotOf('spec')?.kind !== 'desk'));
  assert.equal(s.litSpots().size, 0);
});

test('a status change mid-walk re-paths from the current position without jumping', async () => {
  const s = await sim();
  const a = s.addAgent('server-ops');
  s.setStatus('server-ops', 'working');
  run(s, 1.0); // walk part of the way
  assert.equal(a.state, 'walking');
  const { x, y } = a;
  s.setStatus('server-ops', 'idle');
  assert.deepEqual([a.x, a.y], [x, y]); // not moved by the status change itself
  assert.equal(a.state, 'walking');
  assert.notEqual(s.spots.spotOf('server-ops')?.kind, 'desk');
  let last = [a.x, a.y];
  for (let i = 0; i < 400 && a.state === 'walking'; i++) {
    s.update(0.05);
    const moved = Math.abs(a.x - last[0]) + Math.abs(a.y - last[1]);
    assert.ok(moved <= 3 * 0.05 + 1e-9, `jumped ${moved} tiles`);
    last = [a.x, a.y];
  }
  assert.notEqual(a.state, 'walking');
  const dest = s.spots.spotOf('server-ops') || a.dest;
  assert.deepEqual(a.tile, { x: dest.x, y: dest.y });
});

test('done mid-walk finishes the step and celebrates there', async () => {
  const s = await sim();
  const a = s.addAgent('ask');
  s.setStatus('ask', 'working');
  run(s, 0.7);
  assert.equal(a.state, 'walking');
  s.setStatus('ask', 'done');
  run(s, 1);
  assert.equal(a.state, 'celebrate');
  assert.equal(Number.isInteger(a.x) && Number.isInteger(a.y), true);
});

test('more working agents than desks: the extra ones wait, nothing crashes, a freed desk is taken', async () => {
  const s = await sim();
  const desks = bundled().spots.filter((s2) => s2.kind === 'desk').length;
  const ids = Array.from({ length: desks + 3 }, (_, i) => `w${i}`);
  for (const id of ids) {
    s.addAgent(id);
    s.setStatus(id, 'working');
  }
  run(s, 150);
  const seated = ids.filter((id) => s.agents.get(id).state === 'typing');
  assert.equal(seated.length, desks);
  const waiting = ids.filter((id) => s.agents.get(id).waiting);
  assert.equal(waiting.length, 3);
  for (const id of waiting) assert.equal(s.spots.spotOf(id), null);
  s.setStatus(seated[0], 'idle');
  run(s, 150);
  assert.equal(ids.filter((id) => s.agents.get(id).state === 'typing').length, desks);
});

test('removeAgent frees its spot', async () => {
  const s = await sim();
  s.addAgent('x');
  s.setStatus('x', 'working');
  const desk = s.spots.spotOf('x');
  s.removeAgent('x');
  assert.equal(s.spots.holderOf(desk.id), null);
  assert.equal(s.agents.size, 0);
});

test('reduced motion: agents jump to the destination, no walking state, no timers', async () => {
  const s = await sim({ teleport: true });
  const a = s.addAgent('code');
  s.setStatus('code', 'working');
  const desk = s.spots.spotOf('code');
  assert.equal(a.state, 'typing');
  assert.deepEqual(a.tile, { x: desk.x, y: desk.y });
  s.setStatus('code', 'done');
  assert.equal(a.state, 'celebrate');
  s.update(60); // the celebration ends on wall time even without a frame loop
  assert.notEqual(a.state, 'celebrate');
  s.setStatus('code', 'idle');
  assert.notEqual(a.state, 'walking');
  assert.notEqual(s.spots.spotOf('code')?.kind, 'desk');
  const at = [s.spots.spotOf('code')?.id, a.state];
  s.update(60);
  assert.deepEqual([s.spots.spotOf('code')?.id, a.state], at); // idle agents hold their pose
});

test('switching to reduced motion mid-walk finishes the walk at once', async () => {
  const s = await sim();
  const a = s.addAgent('code');
  s.setStatus('code', 'working');
  run(s, 0.5);
  assert.equal(a.state, 'walking');
  s.setTeleport(true);
  assert.equal(a.state, 'typing');
  const desk = s.spots.spotOf('code');
  assert.deepEqual(a.tile, { x: desk.x, y: desk.y });
});

// ---- renderer helpers ------------------------------------------------------------------------

test('sortDrawables: back to front by foot y, ties by id, independent of input order', async () => {
  const { sortDrawables } = await rendererMod();
  const list = [
    { id: 'b', footY: 40 },
    { id: 'a', footY: 40 },
    { id: 'front', footY: 90 },
    { id: 'back', footY: 10 },
  ];
  const expected = ['back', 'a', 'b', 'front'];
  assert.deepEqual(
    sortDrawables(list).map((d) => d.id),
    expected,
  );
  assert.deepEqual(
    sortDrawables([...list].reverse()).map((d) => d.id),
    expected,
  );
  assert.equal(list[0].id, 'b'); // input untouched
});

test('a character behind a desk is drawn before it, one in front is drawn after', async () => {
  const { sortDrawables, agentFoot } = await rendererMod();
  const T = 16;
  const desk = { id: 'p0', footY: (4 + 1) * T }; // desk prop at y=4, one tile high
  const behind = { id: 'a-behind', footY: agentFoot({ x: 4, y: 3 }).y }; // tile above the desk
  const seated = { id: 'a-seated', footY: agentFoot({ x: 4, y: 5 }).y }; // chair tile below it
  const order = sortDrawables([seated, desk, behind]).map((d) => d.id);
  assert.deepEqual(order, ['a-behind', 'p0', 'a-seated']);
});

const WIDTHS = [0, 280, 375, 500, 640, 768, 1000, 1023, 1024, 1100, 1162, 1280, 1500, 2048, 3000];
const DPRS = [1, 1.25, 1.5, 2, 2.625, 3];

test('canvasMetrics: invariants for every width and DPR', async () => {
  const { canvasMetrics, MIN_CSS_WIDTH, MAX_SCALE } = await rendererMod();
  for (const dpr of DPRS) {
    for (const width of WIDTHS) {
      const m = canvasMetrics(width, 1024, 640, dpr);
      const id = `${width}@${dpr}`;
      for (const v of Object.values(m)) assert.ok(Number.isFinite(v), `${id} not finite`);
      assert.ok(Number.isInteger(m.backingWidth) && Number.isInteger(m.backingHeight), id);
      assert.ok(Math.abs(m.cssWidth * dpr - m.backingWidth) < 1e-6, id);
      assert.ok(Math.abs(m.scale - m.backingWidth / 1024) < 1e-9, id);
      const lo = (MIN_CSS_WIDTH * dpr) / 1024;
      assert.ok(m.scale >= lo - 1e-9 && m.scale <= MAX_SCALE, `${id} scale ${m.scale}`);
      if (width >= MIN_CSS_WIDTH) assert.ok(m.cssWidth <= width + 1e-6, `${id} overflows`);
      else assert.ok(Math.abs(m.cssWidth - MIN_CSS_WIDTH) < 1 / dpr, `${id} not minimum`);
      assert.ok(Math.abs(m.backingWidth / m.backingHeight - 1024 / 640) < 1 / m.backingHeight + 1e-9, id);
    }
  }
});

test('canvasMetrics: never narrower than the minimum, for every integer width and DPR', async () => {
  const { canvasMetrics, MIN_CSS_WIDTH } = await rendererMod();
  for (const dpr of DPRS) {
    for (let width = 1; width <= 1300; width++) {
      const m = canvasMetrics(width, 1024, 640, dpr);
      assert.ok(m.cssWidth >= MIN_CSS_WIDTH - 1e-6, `${width}@${dpr}: ${m.cssWidth}`);
    }
  }
  assert.ok(canvasMetrics(515, 1024, 640, 2).cssWidth >= 640);
  assert.ok(canvasMetrics(360, 1024, 640, 3).cssWidth >= 640);
});

test('canvasMetrics: whole-number scale when it wastes at most 8%, otherwise fit to width', async () => {
  const { canvasMetrics, INTEGER_PREFERENCE } = await rendererMod();
  assert.equal(INTEGER_PREFERENCE, 0.92);
  let integer = 0;
  let fractional = 0;
  for (const dpr of DPRS) {
    for (let width = 640; width <= 3000; width += 7) {
      const fit = (width * dpr) / 1024;
      const s = Math.floor(fit);
      const m = canvasMetrics(width, 1024, 640, dpr);
      if (s >= 1 && s >= (640 * dpr) / 1024 && s / fit >= INTEGER_PREFERENCE) {
        integer++;
        assert.equal(m.scale, Math.min(8, s), `${width}@${dpr}`);
      } else {
        fractional++;
        assert.ok(Math.abs(m.backingWidth - Math.min(fit, 8) * 1024) < 1.0001, `${width}@${dpr}`);
      }
    }
  }
  assert.ok(integer > 0 && fractional > 0);
});

test('canvasMetrics: known values', async () => {
  const { canvasMetrics } = await rendererMod();
  const m = (w, d) => canvasMetrics(w, 1024, 640, d);
  assert.ok(m(1162, 1).cssWidth >= 0.99 * 1162);
  assert.ok(Math.abs(m(1162, 1).scale - 1162 / 1024) < 1 / 1024);
  assert.equal(m(1024, 1).scale, 1);
  assert.equal(m(2048, 1).scale, 2);
  assert.ok(m(1500, 1.5).cssWidth >= 0.92 * 1500);
  assert.ok(m(1162, 1.25).cssWidth >= 0.92 * 1162);
  {
    const fit = (1100 * 2) / 1024; // 2.148: 2 / 2.148 = 0.931 -> whole number
    assert.equal(m(1100, 2).scale, 2 / fit >= 0.92 ? 2 : fit);
  }
  assert.equal(m(375, 3).cssWidth, 640);
  assert.equal(m(375, 1).cssWidth, 640);
  assert.equal(m(0, 1).cssWidth, 640);
  const bad = m(Number.NaN, Number.NaN);
  assert.equal(bad.cssWidth, 640);
  assert.ok(Object.values(canvasMetrics(Infinity, 1024, 640, -2)).every(Number.isFinite));
  assert.equal(m(100000, 1).scale, 8);
});

test('canvasMetrics: at most 8% dead margin from the minimum width up to the real box width', async () => {
  const { canvasMetrics, MIN_CSS_WIDTH } = await rendererMod();
  for (const dpr of DPRS) {
    for (let width = MIN_CSS_WIDTH; width <= 1162; width++) {
      const m = canvasMetrics(width, 1024, 640, dpr);
      assert.ok(m.cssWidth / width >= 0.92, `${width}@${dpr}: ${m.cssWidth}`);
      assert.ok(m.cssWidth <= width + 1e-6, `${width}@${dpr}`);
    }
  }
});

// ---- DPR watcher -----------------------------------------------------------------------------

test('watchDpr: re-arms with the new ratio after every change and cleans up', async () => {
  const { watchDpr } = await import('../public/js/office/dpr-watch.js');
  const queries = [];
  let dpr = 1;
  const matchMedia = (q) => {
    const l = new Set();
    const mq = {
      q,
      l,
      addEventListener: (_t, f) => l.add(f),
      removeEventListener: (_t, f) => l.delete(f),
    };
    queries.push(mq);
    return mq;
  };
  let calls = 0;
  const stop = watchDpr({ matchMedia, getDpr: () => dpr, onChange: () => calls++ });
  assert.equal(queries[0].q, '(resolution: 1dppx)');
  dpr = 2;
  [...queries[0].l].forEach((f) => f());
  assert.equal(calls, 1);
  assert.equal(queries[0].l.size, 0);
  assert.equal(queries[1].q, '(resolution: 2dppx)');
  assert.equal(queries[1].l.size, 1);
  stop();
  assert.equal(queries[1].l.size, 0);
  assert.equal(queries.length, 2);
});

// ---- frame loop ------------------------------------------------------------------------------

function fakeEnv() {
  const env = { pending: new Map(), next: 1, frames: [] };
  env.raf = (cb) => {
    const h = env.next++;
    env.pending.set(h, cb);
    return h;
  };
  env.caf = (h) => env.pending.delete(h);
  env.step = (ts) => {
    const cbs = [...env.pending.values()];
    env.pending.clear();
    cbs.forEach((cb) => cb(ts));
  };
  return env;
}

test('loop: runs continuously, clamps dt, pauses when hidden and resumes without a time jump', async () => {
  const { createLoop, MAX_DT } = await loopMod();
  const env = fakeEnv();
  const loop = createLoop({ frame: (dt) => env.frames.push(dt), raf: env.raf, caf: env.caf });
  loop.invalidate();
  assert.equal(loop.state, 'running');
  env.step(1000);
  env.step(1016);
  env.step(9000); // an 8 s stall
  assert.deepEqual(env.frames.slice(0, 2), [0, 0.016]);
  assert.equal(env.frames[2], MAX_DT);
  assert.equal(env.pending.size, 1);

  loop.setHidden(true);
  assert.equal(loop.state, 'paused');
  assert.equal(env.pending.size, 0); // rAF cancelled
  loop.invalidate(); // work while hidden schedules nothing
  assert.equal(env.pending.size, 0);

  loop.setHidden(false);
  assert.equal(env.pending.size, 1);
  env.step(60_000); // a minute later
  assert.equal(env.frames[3], 0); // no jump
  env.step(60_016);
  assert.equal(env.frames[4], 0.016);
});

test('loop: reduced motion renders on invalidate only, no continuous loop', async () => {
  const { createLoop } = await loopMod();
  const env = fakeEnv();
  const loop = createLoop({ frame: (dt) => env.frames.push(dt), raf: env.raf, caf: env.caf });
  loop.setContinuous(false);
  loop.invalidate();
  env.step(100);
  assert.equal(env.frames.length, 1);
  assert.equal(env.pending.size, 0); // did not reschedule itself
  assert.equal(loop.state, 'static');
  env.step(200);
  assert.equal(env.frames.length, 1);
  loop.invalidate();
  loop.invalidate(); // coalesced
  assert.equal(env.pending.size, 1);
  env.step(300);
  assert.equal(env.frames.length, 2);
  // invalidated while hidden: drawn once on return
  loop.setHidden(true);
  loop.invalidate();
  assert.equal(env.pending.size, 0);
  loop.setHidden(false);
  assert.equal(env.pending.size, 1);
  loop.setContinuous(true);
  env.step(400);
  assert.equal(env.pending.size, 1); // continuous again
});

// ---- atlas-driven rendering helpers ----------------------------------------------------------

test('frameNameFor maps every state to its pose, direction and animation frame', async () => {
  const { frameNameFor } = await rendererMod();
  const at = (state, facing, time = 0, animate = true, id = 'code') =>
    frameNameFor({ id, state, facing }, time, animate);
  assert.deepEqual(at('idle', 'down'), { name: 'char.code.idle.down.0', mirror: false });
  assert.equal(at('idle', 'down', 0.6).name, 'char.code.idle.down.1');
  assert.deepEqual(at('walking', 'up', 0), { name: 'char.code.walk.up.0', mirror: false });
  assert.deepEqual(at('walking', 'right', 0.13), { name: 'char.code.walk.right.1', mirror: false });
  // four-frame walk cycle, wrapping
  const cycle = [0, 0.13, 0.26, 0.39, 0.52].map((t) => at('walking', 'down', t).name);
  assert.deepEqual(
    cycle,
    [0, 1, 2, 3, 0].map((n) => `char.code.walk.down.${n}`),
  );
  // left is the right frame, mirrored at draw time
  assert.deepEqual(at('walking', 'left', 0), { name: 'char.code.walk.right.0', mirror: true });
  assert.deepEqual(at('idle', 'left'), { name: 'char.code.idle.right.0', mirror: true });
  // seated and celebrating poses have their own direction whatever the facing
  for (const facing of ['up', 'down', 'left', 'right']) {
    assert.deepEqual(at('typing', facing), { name: 'char.code.type.up.0', mirror: false });
    assert.deepEqual(at('alert', facing), { name: 'char.code.alert.up.0', mirror: false });
    assert.deepEqual(at('celebrate', facing), { name: 'char.code.celebrate.down.0', mirror: false });
  }
  assert.equal(at('typing', 'up', 0.2).name, 'char.code.type.up.1');
  assert.equal(at('alert', 'up', 0.4).name, 'char.code.alert.up.1');
  assert.equal(at('celebrate', 'down', 0.2).name, 'char.code.celebrate.down.1');
  // the look follows the role, the fallback look is shared
  assert.equal(at('idle', 'down', 0, true, 'ask').name, 'char.ask.idle.down.0');
  assert.equal(at('idle', 'down', 0, true, 'orchestrator').name, 'char.fallback.idle.down.0');
  // reduced motion: every pose holds frame 0, whatever the time
  for (const state of ['idle', 'walking', 'typing', 'alert', 'celebrate']) {
    assert.match(at(state, 'right', 123.456, false).name, /\.0$/, state);
  }
  // odd input falls back to idle / facing down and never throws
  assert.deepEqual(at('nonsense', 'sideways', NaN), { name: 'char.code.idle.down.0', mirror: false });
});

test('a prop taller than its footprint is drawn in front of what stands behind it and behind what stands in front', async () => {
  const { sortDrawables, agentFoot } = await rendererMod();
  const { parseAtlas } = await import('../public/js/office/atlas.js');
  const { propFrameName } = await import('../public/js/office/sprite-format.js');
  const atlas = parseAtlas(
    JSON.parse(
      require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'public', 'office', 'atlas.json'),
        'utf8',
      ),
    ),
  );
  const T = 16;
  // desk (monitor), rack and plant all rise above their footprint through the anchor
  for (const prop of [
    { type: 'desk', x: 4, y: 8, w: 2, h: 1 },
    { type: 'rack', x: 50, y: 9, w: 1, h: 2 },
    { type: 'plant', x: 2, y: 18, w: 1, h: 1 },
  ]) {
    const f = atlas.get(propFrameName(prop));
    assert.ok(f.h > prop.h * T, `${prop.type} sprite is taller than its footprint`);
    assert.equal(f.ay, f.h, `${prop.type} is anchored at the bottom of its frame`);
    const top = (prop.y + prop.h) * T - f.ay;
    assert.ok(top < prop.y * T, `${prop.type} reaches above its footprint`);
    const item = { id: 'p0', footY: (prop.y + prop.h) * T };
    const behind = { id: 'a-behind', footY: agentFoot({ x: prop.x, y: prop.y - 1 }).y };
    const front = { id: 'a-front', footY: agentFoot({ x: prop.x, y: prop.y + prop.h }).y };
    assert.deepEqual(
      sortDrawables([front, item, behind]).map((d) => d.id),
      ['a-behind', 'p0', 'a-front'],
      prop.type,
    );
  }
});
