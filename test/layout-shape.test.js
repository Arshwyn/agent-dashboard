'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shape = require('../src/layout-shape');

const bundled = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'office', 'layout.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const mutate = (fn) => {
  const l = clone(bundled());
  fn(l);
  return l;
};

test('layout-shape: constants match public/js/office/layout-format.js', async () => {
  const fmt = await import('../public/js/office/layout-format.js');
  assert.equal(shape.LAYOUT_VERSION, fmt.LAYOUT_VERSION);
  assert.equal(shape.TILE_SIZE, fmt.TILE_SIZE);
  assert.equal(shape.MAX_DIMENSION, fmt.MAX_DIMENSION);
});

test('layout-shape: the bundled layout passes the cheap check and the full validator', async () => {
  const { validateLayout, parseLayout } = await import('../public/js/office/layout.js');
  assert.equal(shape.looksLikeLayout(bundled()), true);
  assert.doesNotThrow(() => validateLayout(bundled()));
  assert.doesNotThrow(() => parseLayout(bundled()));
});

test('layout-shape: non-layouts are rejected', () => {
  const bad = [
    [],
    {},
    { version: 1 },
    mutate((l) => (l.version = 2)),
    mutate((l) => (l.tileSize = 32)),
    mutate((l) => (l.width = 1.5)),
    mutate((l) => (l.width = 0)),
    mutate((l) => (l.width = 201)),
    mutate((l) => (l.height = '40')),
    mutate((l) => (l.height = 201)),
    mutate((l) => delete l.layers),
    mutate((l) => (l.layers = [])),
    mutate((l) => delete l.layers.floor),
    mutate((l) => l.layers.walls.pop()),
    mutate((l) => (l.layers.decor = 'x')),
    mutate((l) => (l.layers.floor[0] = 5)),
    mutate((l) => (l.zones = {})),
    mutate((l) => delete l.props),
    mutate((l) => (l.spots = null)),
    { name: 'pkg', version: '1.0.0', dependencies: {}, scripts: {} },
    { token: 'abc', password: 'def' },
  ];
  for (const x of bad) assert.equal(shape.looksLikeLayout(x), false, JSON.stringify(x).slice(0, 80));
});

test('layout-shape: never throws on any JSON value', () => {
  for (const x of [
    null,
    true,
    0,
    'str',
    [],
    [[]],
    {},
    { layers: null },
    { version: 1, tileSize: 16, layers: 1 },
  ]) {
    assert.equal(typeof shape.looksLikeLayout(x), 'boolean');
  }
  assert.equal(typeof shape.looksLikeLayout(undefined), 'boolean');
  const evil = new Proxy(
    {},
    {
      get: () => {
        throw new Error('boom');
      },
    },
  );
  assert.equal(shape.looksLikeLayout(evil), false);
});
