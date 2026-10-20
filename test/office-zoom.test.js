'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const zoomMod = () => import('../public/js/office/zoom.js');
const layoutMod = () => import('../public/js/office/layout.js');
const rendererMod = () => import('../public/js/office/renderer.js');

const NATIVE_W = 1024;
const NATIVE_H = 640;

test('ZOOM_LEVELS are the whole numbers 1 to 4', async () => {
  const { ZOOM_LEVELS } = await zoomMod();
  assert.deepEqual([...ZOOM_LEVELS], [1, 2, 3, 4]);
});

test('nextZoom steps through the levels and clamps at both ends', async () => {
  const { nextZoom } = await zoomMod();
  assert.equal(nextZoom(1, 1), 2);
  assert.equal(nextZoom(2, 1), 3);
  assert.equal(nextZoom(3, 1), 4);
  assert.equal(nextZoom(4, 1), 4);
  assert.equal(nextZoom(4, -1), 3);
  assert.equal(nextZoom(1, -1), 1);
  assert.equal(nextZoom(2, 0), 2);
  assert.equal(nextZoom(7, 1), 2, 'an unknown level snaps to 1 first');
  assert.equal(nextZoom(NaN, -1), 1);
});

test('parseStoredZoom accepts only the level strings', async () => {
  const { parseStoredZoom } = await zoomMod();
  for (const z of [1, 2, 3, 4]) assert.equal(parseStoredZoom(String(z)), z);
  for (const bad of [
    null,
    undefined,
    '',
    '0',
    '5',
    '-1',
    '2.5',
    ' 2',
    '2 ',
    '1e0',
    'abc',
    '[2]',
    2,
    {},
    NaN,
  ]) {
    assert.equal(parseStoredZoom(bad), 1, String(bad));
  }
});

test('maxZoomFor keeps the backing width within 8192, only offers levels that grow, and is at least 1', async () => {
  const { maxZoomFor, MAX_BACKING_WIDTH } = await zoomMod();
  const { canvasMetrics } = await rendererMod();
  // the bundled layout is 1024 x 640 native px: the renderer's 8x scale cap is exactly 8192
  assert.equal(maxZoomFor(1280, 1, NATIVE_W, NATIVE_H), 4); // 5x at the top
  assert.equal(maxZoomFor(1280, 2, NATIVE_W, NATIVE_H), 4); // 8192 device px
  assert.equal(maxZoomFor(2500, 1, NATIVE_W, NATIVE_H), 4);
  assert.equal(maxZoomFor(3000, 1, NATIVE_W, NATIVE_H), 3, 'z = 4 would only repeat the 8x cap');
  assert.equal(maxZoomFor(0, 1, NATIVE_W, NATIVE_H), 1);
  // a wider layout makes the 8192 limit bite
  assert.equal(maxZoomFor(1000, 1, 2048, 1280), 4);
  assert.equal(maxZoomFor(2300, 1, 2048, 1280), 3);
  assert.equal(maxZoomFor(5000, 1, 2048, 1280), 1);
  for (const [w, dpr, nw] of [
    [375, 1, 1024],
    [1280, 1, 1024],
    [1280, 3, 1024],
    [1500, 2, 2048],
    [900, 1, 4096],
  ]) {
    const z = maxZoomFor(w, dpr, nw, nw / 1.6);
    const at = (k) => canvasMetrics(w * k, nw, nw / 1.6, dpr).backingWidth;
    assert.ok(z === 1 || at(z) <= MAX_BACKING_WIDTH, `${w}/${dpr}/${nw}`);
    if (z < 4) assert.ok(at(z + 1) > MAX_BACKING_WIDTH || at(z + 1) <= at(z));
  }
});

test('zoom 1 is identical to the plain fit and zoom 2 is about twice as wide', async () => {
  const { canvasMetrics } = await rendererMod();
  const one = canvasMetrics(1280, NATIVE_W, NATIVE_H, 1);
  assert.deepEqual(canvasMetrics(1280 * 1, NATIVE_W, NATIVE_H, 1), one);
  const two = canvasMetrics(1280 * 2, NATIVE_W, NATIVE_H, 1);
  assert.ok(Math.abs(two.backingWidth / one.backingWidth - 2) < 0.1);
});

test('centre maths keeps the same scene point centred', async () => {
  const { centreFraction, scrollForCentre } = await zoomMod();
  assert.equal(centreFraction(0, 800, 800), 0.5, 'content that fits is centred');
  assert.equal(centreFraction(0, 800, 1600), 0.25);
  assert.equal(centreFraction(800, 800, 1600), 0.75);
  assert.equal(scrollForCentre(0.5, 800, 1600), 400);
  assert.equal(scrollForCentre(0.25, 800, 1600), 0);
  assert.equal(scrollForCentre(0.99, 800, 1600), 800, 'clamped to the scroll range');
  assert.equal(scrollForCentre(0.5, 800, 600), 0, 'nothing to scroll');
  // zoom 2 -> 4: the centre fraction survives the width doubling
  const f = centreFraction(300, 800, 1600);
  const next = scrollForCentre(f, 800, 3200);
  assert.ok(Math.abs(centreFraction(next, 800, 3200) - f) < 1e-9);
});

test('readZoom / writeZoom ignore storage that throws or holds junk', async () => {
  const { readZoom, writeZoom } = await zoomMod();
  const boom = () => {
    throw new Error('blocked');
  };
  assert.equal(readZoom(boom), 1);
  assert.doesNotThrow(() => writeZoom(boom, 3));
  assert.equal(
    readZoom(() => ({ getItem: boom })),
    1,
  );
  assert.doesNotThrow(() => writeZoom(() => ({ setItem: boom }), 3));
  assert.equal(
    readZoom(() => ({ getItem: () => '3' })),
    3,
  );
  assert.equal(
    readZoom(() => ({ getItem: () => '99' })),
    1,
  );
  const seen = [];
  writeZoom(() => ({ setItem: (k, v) => seen.push([k, v]) }), 2);
  assert.deepEqual(seen, [['office.zoom', '2']]);
});

test('chooseLayout: override ok, override fails, both fail', async () => {
  const { chooseLayout } = await layoutMod();
  const parse = (l) => {
    if (l.ok !== true) throw new Error(`bad ${l.name}`);
    return l;
  };
  const override = { ok: true, name: 'override' };
  const bundled = { ok: true, name: 'bundled' };
  const warns = [];
  const warn = (m) => warns.push(m);

  let bundledCalls = 0;
  const fetchBundled = async () => {
    bundledCalls++;
    return bundled;
  };
  assert.equal(
    await chooseLayout({ fetchOverride: async () => override, fetchBundled, parse, warn }),
    override,
  );
  assert.equal(bundledCalls, 0, 'the bundled file is not fetched when the override is good');
  assert.deepEqual(warns, []);

  for (const failing of [
    async () => {
      throw new Error('request failed (404)');
    },
    async () => ({ ok: false, name: 'invalid override' }),
  ]) {
    warns.length = 0;
    assert.equal(await chooseLayout({ fetchOverride: failing, fetchBundled, parse, warn }), bundled);
    assert.equal(warns.length, 1);
  }
  assert.match(warns[0], /bad invalid override/);

  warns.length = 0;
  await assert.rejects(
    chooseLayout({
      fetchOverride: async () => {
        throw new Error('nope');
      },
      fetchBundled: async () => ({ ok: false, name: 'bundled' }),
      parse,
      warn,
    }),
    /bad bundled/,
  );
  assert.equal(warns.length, 1);
});

test('chooseLayout with the real validator rejects an override with an unsupported version', async () => {
  const { chooseLayout, parseLayout } = await layoutMod();
  const fs = require('node:fs');
  const path = require('node:path');
  const real = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'office', 'layout.json'), 'utf8'),
  );
  const warns = [];
  const got = await chooseLayout({
    fetchOverride: async () => ({ ...real, version: 99 }),
    fetchBundled: async () => real,
    parse: parseLayout,
    warn: (m) => warns.push(m),
  });
  assert.equal(got.version, real.version);
  assert.equal(warns.length, 1);
});
