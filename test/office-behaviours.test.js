'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const behavioursMod = () => import('../public/js/office/behaviours.js');
const agentMod = () => import('../public/js/office/agent.js');
const spotsMod = () => import('../public/js/office/spots.js');
const gridMod = () => import('../public/js/office/grid.js');
const rendererMod = () => import('../public/js/office/renderer.js');
const onceMod = () => import('../public/js/office/raf-once.js');
const formatMod = () => import('../public/js/office/layout-format.js');

const bundled = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'office', 'layout.json'), 'utf8'));

async function seeded(seed) {
  return (await behavioursMod()).mulberry32(seed);
}

async function sim(seed = 7, opts = {}) {
  const { createSim } = await agentMod();
  return createSim({ layout: bundled(), rng: await seeded(seed), ...opts });
}

function run(s, seconds, each = () => {}, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) {
    s.update(dt);
    each(t);
  }
}

// ---- the behaviour table --------------------------------------------------------------------------

test('behaviours: every spot kind (except desk) has an entry, with valid weights and ranges', async () => {
  const { BEHAVIOURS, WANDER } = await behavioursMod();
  const { SPOT_KINDS } = await formatMod();
  for (const kind of SPOT_KINDS.filter((k) => k !== 'desk')) assert.ok(BEHAVIOURS[kind], kind);
  assert.ok(BEHAVIOURS[WANDER]);
  assert.equal(BEHAVIOURS.desk, undefined);
  for (const [kind, spec] of Object.entries(BEHAVIOURS)) {
    assert.ok(spec.weight > 0, kind);
    assert.ok(spec.steps.length >= 1, kind);
    for (const step of spec.steps) {
      const [lo, hi] = step.secs;
      assert.ok(0 < lo && lo <= hi, `${kind} ${step.state} ${lo}-${hi}`);
      if (step.chance !== undefined) assert.ok(step.chance > 0 && step.chance <= 1);
    }
  }
  // the numbers of the design
  assert.deepEqual(Object.fromEntries(Object.entries(BEHAVIOURS).map(([k, v]) => [k, v.weight])), {
    beanbag: 3,
    coffee: 3,
    whiteboard: 2,
    server: 1.5,
    window: 2,
    plant: 2,
    wander: 1.5,
  });
});

test('behaviours: every activity state has a pose in the renderer', async () => {
  const { ACTIVITY_STATES } = await behavioursMod();
  const { frameNameFor } = await rendererMod();
  const atlas = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'office', 'atlas.json'), 'utf8'),
  );
  for (const state of ACTIVITY_STATES) {
    for (const facing of ['up', 'down', 'left', 'right', 'sideways']) {
      for (const t of [0, 0.3, 0.7]) {
        const { name } = frameNameFor({ id: 'code', state, facing }, t, true);
        assert.ok(atlas.frames[name], `${state}/${facing} -> missing frame ${name}`);
      }
    }
  }
  assert.equal(
    frameNameFor({ id: 'code', state: 'study', facing: 'down' }, 0, true).name,
    'char.code.reach.up.0',
  );
  assert.equal(
    frameNameFor({ id: 'code', state: 'check', facing: 'left' }, 0.4, true).name,
    'char.code.reach.up.1',
  );
  assert.equal(
    frameNameFor({ id: 'code', state: 'water', facing: 'right' }, 0, true).name,
    'char.code.water.up.0',
  );
  assert.equal(
    frameNameFor({ id: 'code', state: 'sit', facing: 'up' }, 5, true).name,
    'char.code.sit.down.0',
  );
  assert.equal(
    frameNameFor({ id: 'code', state: 'sleep', facing: 'up' }, 1.2, true).name,
    'char.code.sleep.down.1',
  );
  assert.equal(
    frameNameFor({ id: 'code', state: 'look', facing: 'down' }, 0, true).name,
    'char.code.idle.down.0',
  );
  assert.equal(
    frameNameFor({ id: 'code', state: 'drink', facing: 'up' }, 0.6, true).name,
    'char.code.drink.down.1',
  );
  // reduced motion: every pose holds frame 0
  for (const state of ACTIVITY_STATES) {
    assert.match(frameNameFor({ id: 'code', state, facing: 'up' }, 99, false).name, /\.0$/, state);
  }
});

test('resolveSteps: draws durations in range and rolls the chance step', async () => {
  const { resolveSteps, BEHAVIOURS } = await behavioursMod();
  const rng = await seeded(5);
  let slept = 0;
  let sat = 0;
  for (let i = 0; i < 500; i++) {
    const steps = resolveSteps('beanbag', rng);
    assert.equal(steps[0].state, 'sit');
    if (steps.length === 2) {
      slept++;
      assert.equal(steps[1].state, 'sleep');
      assert.ok(steps[0].secs >= 3 && steps[0].secs <= 6);
      assert.ok(steps[1].secs >= 10 && steps[1].secs <= 25);
    } else {
      sat++;
      // the failed sleep roll extends the sit for the whole dwell
      assert.ok(steps[0].secs >= 13 && steps[0].secs <= 31);
    }
  }
  assert.ok(slept / 500 > 0.5 && slept / 500 < 0.7, `slept ${slept}/500 (${sat} sat)`);
  assert.equal(BEHAVIOURS.beanbag.steps[1].chance, 0.6);
  assert.deepEqual(
    resolveSteps('coffee', rng).map((s) => s.state),
    ['idle', 'drink'],
  );
  // an unknown kind plays the wander steps
  assert.deepEqual(
    resolveSteps('nonsense', rng).map((s) => s.state),
    ['stretch', 'idle'],
  );
});

// ---- the scheduler --------------------------------------------------------------------------------

const REAL_SPOTS = () => bundled().spots;

test('chooseNext: kind frequencies follow the weights', async () => {
  const { chooseNext, BEHAVIOURS } = await behavioursMod();
  const rng = await seeded(11);
  const free = REAL_SPOTS().filter((s) => s.kind !== 'desk');
  const counts = {};
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const { kind } = chooseNext({ freeSpots: free, rng, recent: [] });
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const total = Object.values(BEHAVIOURS).reduce((a, b) => a + b.weight, 0);
  for (const [kind, spec] of Object.entries(BEHAVIOURS)) {
    const expected = spec.weight / total;
    assert.ok(Math.abs(counts[kind] / N - expected) < 0.02, `${kind}: ${counts[kind] / N} vs ${expected}`);
  }
});

test('chooseNext: the last kind is repeated less often than chance, recent kinds a little less', async () => {
  const { chooseNext, BEHAVIOURS, REPEAT_LAST_FACTOR } = await behavioursMod();
  const free = REAL_SPOTS().filter((s) => s.kind !== 'desk');
  const rate = (recent, kind) => {
    const rng = seeded(3);
    return rng.then((r) => {
      let hit = 0;
      for (let i = 0; i < 20000; i++)
        if (chooseNext({ freeSpots: free, rng: r, recent }).kind === kind) hit++;
      return hit / 20000;
    });
  };
  const base = await rate([], 'coffee');
  const justDid = await rate(['coffee'], 'coffee');
  const earlier = await rate(['coffee', 'plant'], 'coffee');
  assert.ok(justDid < base * 0.5, `${justDid} vs ${base}`);
  assert.ok(earlier < base && earlier > justDid);
  assert.equal(REPEAT_LAST_FACTOR, 0.25);
  assert.ok(BEHAVIOURS.coffee);
});

test('chooseNext: crowded zones are chosen less, and the emptier zone wins the spot', async () => {
  const { chooseNext } = await behavioursMod();
  const free = REAL_SPOTS().filter((s) => s.kind === 'coffee' || s.kind === 'beanbag');
  const rng = await seeded(21);
  const count = (occupancy) => {
    let kitchen = 0;
    for (let i = 0; i < 10000; i++)
      if (chooseNext({ freeSpots: free, rng, occupancy, recent: [] }).kind === 'coffee') kitchen++;
    return kitchen;
  };
  const empty = count(() => 0);
  const crowded = count((z) => (z === 'kitchen' ? 4 : 0));
  assert.ok(crowded < empty * 0.6, `${crowded} vs ${empty}`);
  // two whiteboard-like zones: the spot comes from the less occupied one
  const spots = [
    { id: 'a', zone: 'z1', kind: 'window', x: 0, y: 0, facing: 'down' },
    { id: 'b', zone: 'z2', kind: 'window', x: 1, y: 0, facing: 'down' },
  ];
  for (let i = 0; i < 50; i++) {
    const c = chooseNext({ freeSpots: spots, rng, occupancy: (z) => (z === 'z1' ? 3 : 0), recent: [] });
    if (c.kind === 'window') assert.equal(c.spot.id, 'b');
  }
});

test('chooseNext: never a desk, wander when nothing is free, tolerant of odd input', async () => {
  const { chooseNext } = await behavioursMod();
  const rng = await seeded(2);
  const desks = REAL_SPOTS().filter((s) => s.kind === 'desk');
  for (let i = 0; i < 200; i++) {
    assert.deepEqual(chooseNext({ freeSpots: desks, rng }), { kind: 'wander' });
    assert.deepEqual(chooseNext({ freeSpots: [], rng }), { kind: 'wander' });
    const c = chooseNext({ freeSpots: REAL_SPOTS(), rng });
    assert.notEqual(c.kind, 'desk');
    if (c.spot) assert.notEqual(c.spot.kind, 'desk');
  }
  assert.deepEqual(
    chooseNext({ freeSpots: [{ id: 'x', zone: 'z', kind: 'mystery', x: 0, y: 0, facing: 'up' }], rng }),
    { kind: 'wander' },
  );
});

test('chooseNext with the registry: N agents and M < N spots never double-book or crash', async () => {
  const { chooseNext } = await behavioursMod();
  const { createSpotRegistry } = await spotsMod();
  const rng = await seeded(9);
  const few = REAL_SPOTS()
    .filter((s) => s.kind !== 'desk')
    .slice(0, 5);
  const spots = createSpotRegistry(few);
  const held = new Set();
  for (let i = 0; i < 12; i++) {
    const c = chooseNext({ freeSpots: spots.freeSpots({ notKind: 'desk' }), rng });
    if (c.spot) {
      const got = spots.reserve({ id: c.spot.id }, `a${i}`);
      assert.ok(got);
      assert.ok(!held.has(got.id), 'double-booked');
      held.add(got.id);
    }
  }
  assert.ok(held.size <= 5);
});

// ---- the sim plays the table ------------------------------------------------------------------------

// Records every activity one agent plays: { kind, states: [[state, secs]], spot, facing, arrivedAt }.
function record(s, id, seconds) {
  const out = [];
  let current = null;
  const a = s.agents.get(id);
  run(s, seconds, (t) => {
    if (a.act !== (current && current.act)) {
      if (current) current.states = finish(current);
      current = null;
      if (a.act) {
        current = {
          act: a.act,
          kind: a.act.kind,
          spot: s.spots.spotOf(id),
          facing: a.facing,
          since: t,
          last: a.state,
          lastAt: t,
          log: [],
        };
        out.push(current);
      }
    }
    if (current && a.state !== current.last) {
      current.log.push([current.last, t - current.lastAt]);
      current.last = a.state;
      current.lastAt = t;
    }
    if (current) current.end = t;
  });
  function finish(c) {
    return [...c.log, [c.last, c.end - c.lastAt]];
  }
  const done = out.slice(0, -1); // the last one is still running
  for (const c of done) c.states = c.states || finish(c);
  return done;
}

test('sim: every spot kind plays its steps with durations in range and the spot facing', async () => {
  const { BEHAVIOURS } = await behavioursMod();
  const s = await sim(13);
  s.addAgent('code');
  const acts = record(s, 'code', 1500);
  const byKind = {};
  for (const c of acts) (byKind[c.kind] ||= []).push(c);
  for (const kind of Object.keys(BEHAVIOURS)) assert.ok(byKind[kind]?.length, `never played ${kind}`);
  const tol = 0.1; // sampling step plus walking is not counted: logs start at arrival
  for (const [kind, list] of Object.entries(byKind)) {
    const spec = BEHAVIOURS[kind];
    for (const c of list) {
      const states = c.states.map(([st]) => st);
      const first = spec.steps[0];
      assert.equal(states[0], first.state, kind);
      if (spec.steps.length === 1) {
        assert.deepEqual(states, [first.state], kind);
        const secs = c.states[0][1];
        assert.ok(secs >= first.secs[0] - tol && secs <= first.secs[1] + tol, `${kind} ${secs}`);
      } else if (kind === 'beanbag' && states.length === 1) {
        // sleep roll failed: sat for the whole dwell
        const secs = c.states[0][1];
        assert.ok(secs >= 13 - tol && secs <= 31 + tol, `sit ${secs}`);
      } else {
        assert.deepEqual(
          states,
          spec.steps.map((st) => st.state),
          kind,
        );
        spec.steps.forEach((st, i) => {
          const secs = c.states[i][1];
          assert.ok(secs >= st.secs[0] - tol && secs <= st.secs[1] + tol, `${kind} ${st.state} ${secs}`);
        });
      }
      if (kind !== 'wander') {
        assert.ok(c.spot, `${kind} has a spot`);
        assert.equal(c.spot.kind, kind);
        assert.equal(c.facing, c.spot.facing, `${kind} facing`);
      } else assert.equal(c.spot, null);
    }
  }
  // both the sleep and the no-sleep branch of the bean bag happen
  const bean = byKind.beanbag;
  assert.ok(bean.some((c) => c.states.length === 2) && bean.some((c) => c.states.length === 1));
});

test('sim: waiting for a desk and unreachable cases never leave an activity behind', async () => {
  const s = await sim(4);
  s.addAgent('a');
  assert.ok(s.agents.get('a').act);
  s.setStatus('a', 'working');
  assert.equal(s.agents.get('a').act, null);
  s.setStatus('a', 'blocked');
  assert.equal(s.agents.get('a').act, null);
});

// Moves an agent (by running the sim) until it stands settled on a spot of `kind`.
function settleOn(s, id, kind, seconds = 600) {
  const a = s.agents.get(id) || s.addAgent(id);
  for (let t = 0; t < seconds; t += 0.1) {
    const sp = s.spots.spotOf(id);
    if (sp && sp.kind === kind && a.state !== 'walking') return sp;
    s.update(0.1);
  }
  throw new Error(`never reached a ${kind} spot`);
}

test('release: idle -> working frees the spot in the same tick for another agent', async () => {
  for (const kind of ['beanbag', 'coffee', 'window', 'plant', 'whiteboard', 'server']) {
    const s = await sim(31);
    const a = s.addAgent('x');
    const spot = settleOn(s, 'x', kind);
    assert.equal(s.spots.holderOf(spot.id), 'x');
    s.setStatus('x', 'working');
    assert.equal(a.act, null);
    assert.equal(s.spots.spotOf('x').kind, 'desk');
    assert.equal(s.spots.holderOf(spot.id), null, `${kind} not freed`);
    assert.equal(s.spots.reserve({ id: spot.id }, 'other').id, spot.id);
  }
});

test('release: done, working -> idle, activity end and removeAgent free their spots', async () => {
  const s = await sim(17);
  const a = s.addAgent('x');
  const bean = settleOn(s, 'x', 'beanbag');
  // idle -> done: celebrates in place, the spot goes when the celebration ends
  s.setStatus('x', 'done');
  assert.equal(a.state, 'celebrate');
  assert.equal(a.act, null);
  run(s, 3.2);
  assert.notEqual(a.state, 'celebrate');
  assert.notEqual(s.spots.holderOf(bean.id), 'x');
  // working -> idle frees the desk
  s.setStatus('x', 'working');
  const desk = s.spots.spotOf('x');
  assert.equal(desk.kind, 'desk');
  s.setStatus('x', 'idle');
  assert.equal(s.spots.holderOf(desk.id), null);
  assert.notEqual(s.spots.spotOf('x')?.kind, 'desk');
  // activity end: the old spot is freed when the next is taken (never held twice)
  const seen = [];
  let last = s.spots.spotOf('x');
  run(s, 300, () => {
    const now = s.spots.spotOf('x');
    if (now && last && now.id !== last.id) {
      assert.equal(s.spots.holderOf(last.id), null);
      seen.push(now.id);
    }
    if (now) last = now;
  });
  assert.ok(seen.length > 2);
  // removeAgent
  const held = s.spots.spotOf('x');
  s.removeAgent('x');
  if (held) assert.equal(s.spots.holderOf(held.id), null);
  s.removeAgent('x'); // idempotent
  s.removeAgent('never-there');
  assert.equal(s.agents.size, 0);
});

test('release: removeAgent hands the freed desk to a waiting agent at once', async () => {
  const s = await sim(8);
  const desks = bundled().spots.filter((x) => x.kind === 'desk').length;
  const ids = Array.from({ length: desks + 1 }, (_, i) => `w${i}`);
  for (const id of ids) {
    s.addAgent(id);
    s.setStatus(id, 'working');
  }
  const waiting = ids.filter((id) => s.agents.get(id).waiting);
  assert.equal(waiting.length, 1);
  const holder = ids.find((id) => !s.agents.get(id).waiting);
  const desk = s.spots.spotOf(holder);
  s.removeAgent(holder);
  assert.equal(s.spots.holderOf(desk.id), waiting[0]);
  assert.equal(s.agents.get(waiting[0]).waiting, false);
});

test('transitions are smooth: a status change mid-activity or mid-walk never moves the agent by more than a step', async () => {
  const s = await sim(23);
  const a = s.addAgent('x');
  settleOn(s, 'x', 'beanbag');
  const at = [a.x, a.y];
  s.setStatus('x', 'working');
  assert.deepEqual([a.x, a.y], at); // the status change itself does not move it
  assert.equal(a.state, 'walking');
  let last = at;
  for (let i = 0; i < 2000 && a.state === 'walking'; i++) {
    if (i === 20) s.setStatus('x', 'idle'); // change of mind mid-walk
    const before = [a.x, a.y];
    s.update(0.05);
    assert.ok(Math.abs(a.x - before[0]) + Math.abs(a.y - before[1]) <= 3 * 0.05 + 1e-9);
    last = [a.x, a.y];
  }
  assert.ok(last);
  assert.notEqual(a.state, 'walking');
});

test('working, blocked and done behave as before', async () => {
  const s = await sim(5);
  const a = s.addAgent('code');
  s.setStatus('code', 'working');
  const desk = s.spots.spotOf('code');
  run(s, 120);
  assert.equal(a.state, 'typing');
  assert.ok(s.litSpots().has(desk.id));
  s.setStatus('code', 'blocked');
  assert.equal(a.state, 'alert');
  assert.equal(s.litSpots().size, 0);
  s.setStatus('code', 'done');
  assert.equal(a.state, 'celebrate');
  run(s, 3.5);
  assert.notEqual(a.state, 'celebrate');
});

test('anti-herding: 10 idle agents spread over the zones on the real layout', async () => {
  const s = await sim(99);
  const ids = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
  ids.forEach((id) => s.addAgent(id));
  const visited = new Set();
  let overSince = null;
  let worst = 0;
  for (let t = 0; t < 60; t += 0.1) {
    s.update(0.1);
    const counts = {};
    for (const id of ids) {
      const z = s.zoneOf(s.agents.get(id));
      visited.add(z);
      counts[z] = (counts[z] || 0) + 1;
    }
    const top = Math.max(...Object.values(counts)) / ids.length;
    if (top > 0.7) {
      overSince ??= t;
      worst = Math.max(worst, t - overSince);
    } else overSince = null;
  }
  assert.ok(worst <= 5, `a zone held more than 70% of the agents for ${worst}s`);
  assert.ok(visited.size >= 4, `only ${[...visited]}`);
});

test('many agents: more than there are spots and desks, nobody crashes or shares a spot', async () => {
  const s = await sim(77);
  const ids = Array.from({ length: 80 }, (_, i) => `m${i}`);
  ids.forEach((id) => s.addAgent(id));
  ids.slice(0, 30).forEach((id) => s.setStatus(id, 'working'));
  for (let i = 0; i < 400; i++) {
    s.update(0.25);
    const held = ids.map((id) => s.spots.spotOf(id)?.id).filter(Boolean);
    assert.equal(new Set(held).size, held.length);
  }
});

// ---- reduced motion -----------------------------------------------------------------------------------

test('reduced motion: celebrate ends on advance(), spot released, nothing walks, idle agents hold their pose', async () => {
  const s = await sim(6, { teleport: true, celebrateSecs: 3 });
  const a = s.addAgent('code');
  s.setStatus('code', 'working');
  assert.equal(a.state, 'typing');
  const desk = s.spots.spotOf('code');
  assert.equal(s.nextWake(), Infinity);
  s.setStatus('code', 'done');
  assert.equal(a.state, 'celebrate');
  assert.ok(Math.abs(s.nextWake() - 3) < 1e-9);
  assert.equal(s.advance(1), false); // nothing visible changed yet
  assert.ok(Math.abs(s.nextWake() - 2) < 1e-9);
  assert.equal(s.advance(2.1), true);
  assert.notEqual(a.state, 'celebrate');
  assert.notEqual(a.state, 'walking');
  assert.equal(s.spots.holderOf(desk.id), null);
  assert.equal(s.nextWake(), Infinity);
  // idle agents never cycle activities, and never walk
  const snapshot = () =>
    [...s.agents.values()].map((x) => `${x.id}:${x.state}:${s.spots.spotOf(x.id)?.id}`).join();
  s.addAgent('other');
  const before = snapshot();
  for (let i = 0; i < 100; i++) {
    s.update(5);
    assert.ok([...s.agents.values()].every((x) => x.state !== 'walking'));
  }
  s.advance(600);
  assert.equal(snapshot(), before);
});

test('reduced motion: a desk-waiting agent takes a desk the moment one is freed, and via advance', async () => {
  const s = await sim(12, { teleport: true });
  const desks = bundled().spots.filter((x) => x.kind === 'desk').length;
  const ids = Array.from({ length: desks + 2 }, (_, i) => `w${i}`);
  for (const id of ids) {
    s.addAgent(id);
    s.setStatus(id, 'working');
  }
  const waiting = ids.filter((id) => s.agents.get(id).waiting);
  assert.equal(waiting.length, 2);
  const seated = ids.filter((id) => !s.agents.get(id).waiting);
  s.setStatus(seated[0], 'idle'); // event-driven: no advance needed
  assert.equal(s.agents.get(waiting[0]).state, 'typing');
  assert.equal(s.agents.get(waiting[0]).waiting, false);
  // the second one is still waiting; a freed desk is also found by advance() alone
  assert.equal(s.agents.get(waiting[1]).waiting, true);
  s.setStatus(seated[1], 'done'); // the desk is kept while celebrating
  assert.equal(s.agents.get(waiting[1]).waiting, true);
  s.advance(3.5); // the celebration ends, the desk is released and handed on
  assert.equal(s.agents.get(waiting[1]).waiting, false);
  assert.equal(s.agents.get(waiting[1]).state, 'typing');
});

test('reduced motion: leaving it lets the scheduler resume from the current activity', async () => {
  const s = await sim(14, { teleport: true });
  const a = s.addAgent('x');
  const spot = s.spots.spotOf('x');
  s.update(100);
  assert.equal(s.spots.spotOf('x')?.id, spot?.id);
  s.setTeleport(false);
  run(s, 200);
  assert.ok(a.act);
  // it has moved on by now
  assert.notEqual(s.spots.spotOf('x')?.id, spot?.id);
});

// ---- helpers: coalescing, metrics, seed ------------------------------------------------------------

test('scheduleOnce: many requests in a frame run once; cancel; a later request runs again', async () => {
  const { scheduleOnce } = await onceMod();
  const queue = new Map();
  let id = 0;
  let runs = 0;
  const raf = (cb) => {
    queue.set(++id, cb);
    return id;
  };
  const caf = (h) => queue.delete(h);
  const flush = () => {
    const cbs = [...queue.values()];
    queue.clear();
    cbs.forEach((cb) => cb());
  };
  const once = scheduleOnce({ raf, caf, run: () => runs++ });
  for (let i = 0; i < 50; i++) once.request();
  assert.equal(queue.size, 1);
  assert.equal(once.pending, true);
  flush();
  assert.equal(runs, 1);
  assert.equal(once.pending, false);
  once.request();
  once.cancel();
  flush();
  assert.equal(runs, 1);
  once.cancel(); // harmless twice
  once.request();
  flush();
  assert.equal(runs, 2);
});

test('sameMetrics: equal sizes are a no-op, any difference is not', async () => {
  const { sameMetrics, canvasMetrics } = await rendererMod();
  const a = canvasMetrics(1100, 1024, 640, 1);
  assert.equal(sameMetrics(a, canvasMetrics(1100, 1024, 640, 1)), true);
  assert.equal(
    sameMetrics(a, canvasMetrics(1102, 1024, 640, 1)),
    a.backingWidth === canvasMetrics(1102, 1024, 640, 1).backingWidth,
  );
  assert.equal(sameMetrics(a, canvasMetrics(1100, 1024, 640, 2)), false);
  assert.equal(sameMetrics(canvasMetrics(1280, 1024, 640, 1), canvasMetrics(900, 1024, 640, 1)), false);
});

test('seed hook: ?office-seed is parsed strictly and mulberry32 is deterministic', async () => {
  const { seedFromSearch, mulberry32 } = await behavioursMod();
  assert.equal(seedFromSearch('?office-seed=42'), 42);
  assert.equal(seedFromSearch('?x=1&office-seed=7'), 7);
  assert.equal(seedFromSearch('?office-seed=-3'), -3);
  for (const bad of [
    '',
    '?',
    '?office-seed=',
    '?office-seed=abc',
    '?office-seed=1.5',
    '?office-seed=1e3',
    undefined,
    null,
  ])
    assert.equal(seedFromSearch(bad), null);
  const a = mulberry32(5);
  const b = mulberry32(5);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  assert.notEqual(mulberry32(5)(), mulberry32(6)());
});

// ---- the layout ---------------------------------------------------------------------------------------

test('layout: spot counts per kind did not decrease, ids are unique, every spot is reachable', async () => {
  const L = bundled();
  const counts = {};
  for (const sp of L.spots) counts[sp.kind] = (counts[sp.kind] || 0) + 1;
  const floor = { desk: 16, beanbag: 12, coffee: 4, whiteboard: 4, server: 9, window: 6, plant: 4 };
  for (const [kind, n] of Object.entries(floor))
    assert.ok(counts[kind] >= n, `${kind}: ${counts[kind]} < ${n}`);
  assert.equal(new Set(L.spots.map((x) => x.id)).size, L.spots.length);
  const { buildGrid, findPath } = await gridMod();
  const { spawnOf } = await import('../public/js/office/layout.js');
  const grid = buildGrid(L);
  const spawn = spawnOf(L, grid);
  for (const sp of L.spots) assert.ok(findPath(grid, spawn, { x: sp.x, y: sp.y }), sp.id);
});

test('layout: no new one-tile-wide pass-through (a walkable tile blocked on both opposite sides)', async () => {
  const L = bundled();
  const { buildGrid } = await gridMod();
  const grid = buildGrid(L);
  const spots = new Set(L.spots.map((s) => `${s.x},${s.y}`));
  const w = (x, y) => grid.isWalkable(x, y);
  const narrow = [];
  for (let y = 0; y < L.height; y++) {
    for (let x = 0; x < L.width; x++) {
      if (!w(x, y) || spots.has(`${x},${y}`)) continue;
      if ((!w(x - 1, y) && !w(x + 1, y)) || (!w(x, y - 1) && !w(x, y + 1))) narrow.push(`${x},${y}`);
    }
  }
  // Pockets that existed before the kitchen and garden decor: the gaps between the server racks and
  // beside corner plants. The decor added none.
  const known = new Set(
    '1,2 32,2 46,2 51,2 53,2 55,2 57,2 59,2 51,3 53,3 55,3 57,3 59,3 51,9 53,9 55,9 57,9 59,9 51,10 53,10 55,10 57,10 59,10 1,18 2,19 28,19 32,19 46,19 1,25 22,25 24,25 26,25 1,36 24,36 44,36 62,36 2,37 23,37 45,37 61,37'.split(
      ' ',
    ),
  );
  assert.deepEqual(
    narrow.filter((t) => !known.has(t)),
    [],
  );
});
