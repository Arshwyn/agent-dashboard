'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../public/js/office/layout.js');
const loadGrid = () => import('../public/js/office/grid.js');
const LAYOUT_FILE = path.join(__dirname, '..', 'public', 'office', 'layout.json');
const bundled = () => JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// A tiny valid layout: 12x6, spawn in the middle row, all six zones, one desk.
function tiny() {
  const rows = (c) => Array.from({ length: 6 }, () => c.repeat(12));
  const walls = rows('.');
  walls[0] = '#'.repeat(12);
  return {
    version: 1,
    tileSize: 16,
    width: 12,
    height: 6,
    spawn: { x: 1, y: 3 },
    layers: { floor: rows('.'), walls, decor: rows('.') },
    zones: ['workspace', 'lounge', 'kitchen', 'meeting', 'server', 'window'].map((kind, i) => ({
      id: kind,
      kind,
      rect: { x: i * 2, y: 1, w: 2, h: 5 },
    })),
    spots: [{ id: 'd1', zone: 'workspace', kind: 'desk', x: 0, y: 2, facing: 'up', seat: true }],
    props: [{ type: 'desk', x: 0, y: 1, w: 2, h: 1, blocking: true }],
  };
}

test('the bundled layout is valid, big, and has every zone and spot kind', async () => {
  const { validateLayout } = await load();
  const l = bundled();
  assert.deepEqual(validateLayout(l), []);
  assert.equal(l.version, 1);
  assert.equal(l.tileSize, 16);
  // at least 2.5x the old 576x352 floor, at native resolution
  assert.ok(l.width * 16 * l.height * 16 >= 2.5 * 576 * 352);
  for (const k of ['workspace', 'lounge', 'kitchen', 'meeting', 'server', 'window']) {
    assert.ok(
      l.zones.some((z) => z.kind === k),
      k,
    );
  }
  assert.ok(l.spots.filter((s) => s.kind === 'desk').length >= 12);
  for (const k of ['desk', 'beanbag', 'coffee', 'whiteboard', 'server', 'window', 'plant']) {
    assert.ok(
      l.spots.some((s) => s.kind === k),
      k,
    );
  }
});

test('every spot of the bundled layout is reachable from the spawn point', async () => {
  const { spawnOf } = await load();
  const { buildGrid, findPath } = await loadGrid();
  const l = bundled();
  const grid = buildGrid(l);
  const spawn = spawnOf(l, grid);
  for (const s of l.spots) assert.ok(findPath(grid, spawn, s), `${s.id} unreachable`);
});

test('the tiny test layout is valid', async () => {
  const { validateLayout } = await load();
  assert.deepEqual(validateLayout(tiny()), []);
});

const BAD = [
  [
    'wrong version',
    (l) => {
      l.version = 2;
    },
    /unsupported version 2/,
  ],
  ['wrong tile size', (l) => (l.tileSize = 32), /tileSize/],
  ['bad dimensions', (l) => (l.width = 0), /width and height/],
  ['short row', (l) => (l.layers.floor[2] = '...'), /layers\.floor row 2/],
  ['unknown tile char', (l) => (l.layers.floor[1] = 'Z' + '.'.repeat(11)), /unknown tile character 'Z'/],
  ['out-of-bounds spot', (l) => (l.spots[0].x = 99), /out of bounds/],
  ['spot on a wall', (l) => (l.spots[0].y = 0), /blocked tile/],
  ['spot on a blocking prop', (l) => (l.spots[0].y = 1), /blocked tile/],
  ['duplicate spot id', (l) => l.spots.push({ ...l.spots[0], x: 5, y: 3 }), /duplicate spot id 'd1'/],
  ['two spots on one tile', (l) => l.spots.push({ ...l.spots[0], id: 'd2' }), /share tile/],
  ['unknown spot kind', (l) => (l.spots[0].kind = 'sofa'), /unknown kind 'sofa'/],
  ['unknown facing', (l) => (l.spots[0].facing = 'north'), /unknown facing/],
  ['unknown zone', (l) => (l.spots[0].zone = 'nowhere'), /unknown zone 'nowhere'/],
  ['spot outside its zone', (l) => ((l.spots[0].x = 9), (l.spots[0].y = 3)), /outside its zone/],
  ['duplicate zone id', (l) => (l.zones[1].id = 'workspace'), /duplicate zone id/],
  ['unknown zone kind', (l) => (l.zones[1].kind = 'garage'), /unknown kind 'garage'/],
  ['missing zone kind', (l) => l.zones.pop(), /missing a zone of kind 'window'/],
  ['zone out of bounds', (l) => (l.zones[0].rect.w = 50), /rect is out of bounds/],
  ['unknown prop type', (l) => (l.props[0].type = 'ufo'), /unknown type 'ufo'/],
  ['prop size without a sprite', (l) => (l.props[0].w = 3), /no sprite for a 3x1 footprint/],
  ['prop out of bounds', (l) => (l.props[0].x = 11), /out of bounds/],
  ['prop without blocking flag', (l) => delete l.props[0].blocking, /boolean blocking/],
  ['no desk', (l) => ((l.spots[0].kind = 'plant'), (l.spots[0].zone = 'workspace')), /at least one desk/],
  [
    'unreachable desk',
    (l) => {
      // wall the desk at (0,2) in
      l.layers.walls[1] = '#' + '.'.repeat(11);
      l.layers.walls[2] = '.#' + '.'.repeat(10);
      l.layers.walls[3] = '#' + '.'.repeat(11);
      l.spots[0].x = 0;
      l.spots[0].y = 2;
      l.props = [];
    },
    /desk spot 'd1' is not reachable/,
  ],
  ['spawn on a wall', (l) => (l.spawn = { x: 3, y: 0 }), /spawn is on a blocked tile/],
  ['spawn out of bounds', (l) => (l.spawn = { x: 30, y: 0 }), /spawn is out of bounds/],
];

for (const [name, mutate, message] of BAD) {
  test(`bad layout is rejected with a clear message: ${name}`, async () => {
    const { validateLayout, parseLayout, LayoutError } = await load();
    const l = clone(tiny());
    mutate(l);
    const errors = validateLayout(l);
    assert.ok(errors.length > 0, 'expected errors');
    assert.ok(
      errors.some((e) => message.test(e)),
      `${message} not in ${JSON.stringify(errors)}`,
    );
    assert.throws(() => parseLayout(l), LayoutError);
  });
}

test('a layout that is not an object is rejected', async () => {
  const { validateLayout } = await load();
  assert.deepEqual(validateLayout(null), ['layout must be a JSON object']);
});

test('validateLayout never throws on junk input', async () => {
  const { validateLayout } = await load();
  for (const junk of [
    undefined,
    5,
    'x',
    [],
    { version: 1 },
    { version: 1, tileSize: 16, width: 2, height: 2 },
  ]) {
    assert.ok(Array.isArray(validateLayout(junk)));
    assert.ok(validateLayout(junk).length > 0);
  }
});

const decorAt = (l, x, y) => l.layers.decor[y][x];

test('every lounge bean bag spot sits on the rug with a tile of margin left, right and up', () => {
  const l = bundled();
  const bags = l.spots.filter((s) => s.kind === 'beanbag' && s.zone === 'lounge');
  assert.equal(bags.length, 12);
  for (const s of bags) {
    for (const [dx, dy] of [
      [0, 0],
      [-1, 0],
      [1, 0],
      [0, -1],
    ]) {
      assert.equal(decorAt(l, s.x + dx, s.y + dy), 'r', `${s.id} needs rug at ${s.x + dx},${s.y + dy}`);
    }
  }
});

test('every beanbag spot and beanbag prop of the bundled layout is on a rug tile', () => {
  const l = bundled();
  const spots = l.spots.filter((s) => s.kind === 'beanbag');
  assert.ok(spots.length > 0);
  for (const s of spots) assert.equal(decorAt(l, s.x, s.y), 'r', `${s.id} is off the rug`);
  const props = l.props.filter((p) => p.type === 'beanbag');
  assert.ok(props.length > 0);
  for (const p of props) {
    for (let y = p.y; y < p.y + (p.h || 1); y++) {
      for (let x = p.x; x < p.x + (p.w || 1); x++) {
        assert.equal(decorAt(l, x, y), 'r', `beanbag prop at ${x},${y} is off the rug`);
      }
    }
  }
});

// The meeting table intentionally stands on the meeting rug, so the prop check is
// scoped to the lounge rug; the wall check covers every rug tile.
test('rug tiles never sit on a wall tile, and the lounge rug never under a blocking prop', () => {
  const l = bundled();
  const lounge = l.zones.find((z) => z.id === 'lounge').rect;
  const blocked = new Set();
  for (const p of l.props.filter((q) => q.blocking)) {
    for (let y = p.y; y < p.y + (p.h || 1); y++) {
      for (let x = p.x; x < p.x + (p.w || 1); x++) blocked.add(`${x},${y}`);
    }
  }
  let rugTiles = 0;
  for (let y = 0; y < l.height; y++) {
    for (let x = 0; x < l.width; x++) {
      if (decorAt(l, x, y) !== 'r') continue;
      rugTiles++;
      assert.notEqual(l.layers.walls[y][x], '#', `rug on wall at ${x},${y}`);
      const inLounge = x >= lounge.x && x < lounge.x + lounge.w && y >= lounge.y && y < lounge.y + lounge.h;
      if (inLounge) assert.ok(!blocked.has(`${x},${y}`), `rug under blocking prop at ${x},${y}`);
    }
  }
  assert.ok(rugTiles > 0);
});
