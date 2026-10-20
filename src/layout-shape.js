'use strict';

// A cheap structural check that a parsed JSON value is an office layout. The server uses it so that
// OFFICE_LAYOUT_PATH can only ever serve layout-shaped files. The browser still runs the full
// validator (public/js/office/layout.js).
//
// These constants are duplicated from public/js/office/layout-format.js because the server is
// CommonJS and cannot import browser ES modules; test/layout-shape.test.js fails if they drift.
const LAYOUT_VERSION = 1;
const TILE_SIZE = 16;
const MAX_DIMENSION = 200;

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const isDimension = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;
const isRows = (a, height) =>
  Array.isArray(a) && a.length === height && a.every((r) => typeof r === 'string');

function looksLikeLayout(x) {
  try {
    if (!isObject(x)) return false;
    if (x.version !== LAYOUT_VERSION || x.tileSize !== TILE_SIZE) return false;
    if (!isDimension(x.width) || !isDimension(x.height)) return false;
    const { layers } = x;
    if (!isObject(layers)) return false;
    if (
      !isRows(layers.floor, x.height) ||
      !isRows(layers.walls, x.height) ||
      !isRows(layers.decor, x.height)
    ) {
      return false;
    }
    return Array.isArray(x.zones) && Array.isArray(x.props) && Array.isArray(x.spots);
  } catch {
    return false;
  }
}

module.exports = { LAYOUT_VERSION, TILE_SIZE, MAX_DIMENSION, looksLikeLayout };
