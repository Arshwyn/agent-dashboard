'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = () => import('../public/js/office/step-map.js');
const NOW = 1_000_000;
const st = (step, ts, repo = 'example-app') => ({ run_id: `${repo}-${step}`, repo, step, ts, attempt: 1 });
const sub = (step, substep, ts, repo = 'example-app') => ({
  run_id: `${repo}-${substep}`,
  repo,
  step,
  substep,
  ts,
  attempt: 1,
});

test('step to character mapping and icons', async () => {
  const { STEP_TO_CHARACTER, INDICATORS, indicatorFor } = await mod();
  assert.deepEqual(STEP_TO_CHARACTER, {
    test: 'verify',
    styling: 'verify',
    security: 'review',
    'code-review': 'review',
  });
  assert.deepEqual(INDICATORS, {
    verify: { test: 'flask', styling: 'brush' },
    review: { security: 'shield', 'code-review': 'magnifier' },
  });
  assert.deepEqual(indicatorFor('verify', [st('test', NOW - 5)], NOW), {
    step: 'verify',
    substep: 'test',
    icon: 'flask',
    label: 'TEST',
  });
  assert.equal(indicatorFor('review', [st('code-review', NOW)], NOW).label, 'CODE REVIEW');
  assert.equal(indicatorFor('review', [st('security', NOW)], NOW).icon, 'shield');
  assert.equal(indicatorFor('verify', [st('styling', NOW)], NOW).icon, 'brush');
});

test('new shape {step: parent, substep} and legacy {step: gate} give the same indicator', async () => {
  const { indicatorFor, stepsFor } = await mod();
  for (const [g, parent, icon, label] of [
    ['test', 'verify', 'flask', 'TEST'],
    ['styling', 'verify', 'brush', 'STYLING'],
    ['security', 'review', 'shield', 'SECURITY'],
    ['code-review', 'review', 'magnifier', 'CODE REVIEW'],
  ]) {
    const want = { step: parent, substep: g, icon, label };
    assert.deepEqual(indicatorFor(parent, [sub(parent, g, NOW)], NOW), want);
    assert.deepEqual(indicatorFor(parent, [st(g, NOW)], NOW), want);
  }
  // a substep that belongs to the other parent is treated as no substep
  assert.equal(indicatorFor('verify', [sub('verify', 'security', NOW)], NOW).substep, null);
  assert.deepEqual(
    stepsFor('verify', [st('test', NOW - 2), sub('verify', 'styling', NOW)], NOW).map((s) => s.substep),
    ['styling', 'test'],
  );
});

test('a parent active with no substep is a text label with no icon; a substep entry wins', async () => {
  const { indicatorFor } = await mod();
  assert.deepEqual(indicatorFor('verify', [st('verify', NOW)], NOW), {
    step: 'verify',
    substep: null,
    icon: null,
    label: 'VERIFY',
  });
  assert.equal(indicatorFor('review', [st('review', NOW)], NOW).label, 'REVIEW');
  const list = [st('verify', NOW), sub('verify', 'test', NOW - 5, 'b')];
  assert.equal(indicatorFor('verify', list, NOW).icon, 'flask');
});

test('newest ts wins, also across parallel runs and when listed out of order', async () => {
  const { indicatorFor } = await mod();
  const list = [st('test', NOW - 10, 'a'), st('styling', NOW - 5, 'b')];
  assert.equal(indicatorFor('verify', list, NOW).substep, 'styling');
  assert.equal(indicatorFor('verify', [...list].reverse(), NOW).substep, 'styling');
  // styling passed (gone from the list), then test active in one batch: only test remains
  assert.equal(indicatorFor('verify', [st('test', NOW)], NOW).icon, 'flask');
  // other character's steps never leak
  assert.equal(indicatorFor('verify', [st('security', NOW)], NOW), null);
});

test('none, stale, unknown, legacy and malformed input give a neutral indicator', async () => {
  const { indicatorFor, STALE_MS } = await mod();
  assert.equal(indicatorFor('verify', [], NOW), null);
  assert.equal(indicatorFor('verify', undefined, NOW), null);
  assert.equal(indicatorFor('verify', [st('test', NOW - STALE_MS - 1)], NOW), null);
  assert.ok(indicatorFor('verify', [st('test', NOW - STALE_MS)], NOW));
  assert.equal(indicatorFor('verify', [st('bogus', NOW), st('constructor', NOW)], NOW), null);
  assert.equal(indicatorFor('verify', [st('verify', NOW - STALE_MS - 1)], NOW), null);
  assert.equal(indicatorFor('verify', [null, {}, { step: 'test' }], NOW), null);
  // legacy-named characters have no indicator
  for (const c of ['test', 'styling', 'security', 'code-review', 'code', 'constructor'])
    assert.equal(indicatorFor(c, [st('test', NOW), st('security', NOW)], NOW), null);
});

test('stepsFor lists every non-stale step of the character, newest first', async () => {
  const { stepsFor } = await mod();
  const list = [st('test', NOW - 9, 'a'), st('styling', NOW - 3, 'b'), st('security', NOW)];
  assert.deepEqual(
    stepsFor('verify', list, NOW).map((s) => s.substep),
    ['styling', 'test'],
  );
});

test('iconFrames: out then in, instant when reduced or settled', async () => {
  const { iconFrames, TRANSITION_S } = await mod();
  assert.deepEqual(iconFrames('flask', 'flask', 0.1), [{ icon: 'flask', alpha: 1, dy: 0 }]);
  const early = iconFrames('flask', 'brush', 0.05);
  assert.equal(early.length, 1);
  assert.equal(early[0].icon, 'flask');
  assert.ok(early[0].alpha < 1 && early[0].alpha > 0);
  const late = iconFrames('flask', 'brush', TRANSITION_S * 0.75);
  assert.equal(late[0].icon, 'brush');
  assert.ok(late[0].alpha > 0 && late[0].alpha < 1);
  assert.deepEqual(iconFrames('flask', 'brush', TRANSITION_S), [{ icon: 'brush', alpha: 1, dy: 0 }]);
  assert.deepEqual(iconFrames('flask', 'brush', 0.05, true), [{ icon: 'brush', alpha: 1, dy: 0 }]);
  assert.deepEqual(iconFrames('flask', null, 0.3), []);
  assert.deepEqual(iconFrames(null, 'flask', 0.05), []);
  assert.deepEqual(iconFrames('flask', null, 0.05).length, 1);
  assert.ok(TRANSITION_S >= 0.3 && TRANSITION_S <= 0.5);
});

test('abandoned entries never produce an indicator', async () => {
  const { indicatorFor, stepsFor } = await mod();
  const e = { ...sub('verify', 'test', NOW - 1000), abandoned: true };
  assert.equal(indicatorFor('verify', [e], NOW), null);
  assert.deepEqual(stepsFor('verify', [e], NOW), []);
});

// ---- named people: role-based indicators, newest busy person only -----------------------------------

test('indicatorOwners: the newest busy person of a merged role owns the icon', async () => {
  const { indicatorOwners } = await mod();
  const view = (id, role, over = {}) => ({
    id,
    role,
    status: 'working',
    stale: false,
    run_started_ts: 100,
    ...over,
  });
  const owners = indicatorOwners([
    view('Ada', 'verify', { run_started_ts: 100 }),
    view('Bram', 'verify', { run_started_ts: 300 }),
    view('Carl', 'review', { run_started_ts: 200 }),
    view('Dax', 'code', { run_started_ts: 400 }),
  ]);
  assert.equal(owners.get('verify'), 'Bram');
  assert.equal(owners.get('review'), 'Carl');
  assert.equal(owners.has('code'), false, 'only merged roles have indicators');
});

test('indicatorOwners: idle, resting, done and stale people never own it; ties go to the lowest id', async () => {
  const { indicatorOwners } = await mod();
  const v = (id, over = {}) => ({
    id,
    role: 'verify',
    status: 'working',
    stale: false,
    run_started_ts: 5,
    ...over,
  });
  assert.equal(
    indicatorOwners([
      v('Ada', { status: 'resting' }),
      v('Bram', { status: 'done' }),
      v('Carl', { status: 'idle' }),
      v('Dax', { stale: true }),
    ]).size,
    0,
  );
  assert.equal(indicatorOwners([v('Bram'), v('Ada')]).get('verify'), 'Ada');
  assert.equal(indicatorOwners([v('Bram', { status: 'blocked' })]).get('verify'), 'Bram');
  assert.equal(indicatorOwners(null).size, 0);
  assert.equal(indicatorOwners([null, { id: 'x' }, { id: 'y', role: 5 }]).size, 0);
});

test('a person is matched by the role they do now: stepsFor takes the role, not the card id', async () => {
  const { stepsFor, indicatorFor } = await mod();
  const active = [{ run_id: 'r', step: 'review', substep: 'security', ts: 1000, repo: 'x' }];
  assert.equal(stepsFor('review', active, 1000).length, 1);
  assert.equal(stepsFor('Carl', active, 1000).length, 0, 'a person name is not a character');
  assert.equal(indicatorFor('review', active, 1000).icon, 'shield');
});
