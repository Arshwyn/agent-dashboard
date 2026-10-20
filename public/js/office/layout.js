// Layout validator and loader helpers. Pure (no DOM, no fetch) so it runs under `node --test`.

import {
  LAYOUT_VERSION,
  TILE_SIZE,
  MAX_DIMENSION,
  ZONE_KINDS,
  SPOT_KINDS,
  PROP_TYPES,
  FACINGS,
  FLOOR_CHARS,
  WALL_CHARS,
  DECOR_CHARS,
  EMPTY_CHAR,
} from './layout-format.js';
import { propFrameName } from './sprite-format.js';
import { buildGrid, reachableFrom } from './grid.js';

export class LayoutError extends Error {
  constructor(errors) {
    super(`Invalid office layout: ${errors.join('; ')}`);
    this.name = 'LayoutError';
    this.errors = errors;
  }
}

const isInt = (n) => Number.isInteger(n);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

function checkLayer(errors, layer, name, width, height, allowed) {
  if (!Array.isArray(layer) || layer.length !== height) {
    errors.push(`layers.${name} must be an array of ${height} row strings`);
    return false;
  }
  let ok = true;
  layer.forEach((row, y) => {
    if (typeof row !== 'string' || row.length !== width) {
      errors.push(`layers.${name} row ${y} must be a string of ${width} characters`);
      ok = false;
      return;
    }
    for (let x = 0; x < width; x++) {
      if (!allowed.includes(row[x])) {
        errors.push(`layers.${name} row ${y} column ${x}: unknown tile character '${row[x]}'`);
        ok = false;
        return;
      }
    }
  });
  return ok;
}

const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

// Returns the list of problems (empty when the layout is valid). Never throws on bad input.
export function validateLayout(layout) {
  const errors = [];
  if (!isObj(layout)) return ['layout must be a JSON object'];
  if (layout.version !== LAYOUT_VERSION) {
    errors.push(`unsupported version ${JSON.stringify(layout.version)} (expected ${LAYOUT_VERSION})`);
    return errors;
  }
  if (layout.tileSize !== TILE_SIZE) errors.push(`tileSize must be ${TILE_SIZE}`);
  const { width, height } = layout;
  const dimOk = (n) => isInt(n) && n >= 1 && n <= MAX_DIMENSION;
  if (!dimOk(width) || !dimOk(height)) {
    errors.push(`width and height must be integers from 1 to ${MAX_DIMENSION}`);
    return errors;
  }

  const layers = isObj(layout.layers) ? layout.layers : {};
  const layersOk = [
    checkLayer(errors, layers.floor, 'floor', width, height, Object.keys(FLOOR_CHARS)),
    checkLayer(errors, layers.walls, 'walls', width, height, [EMPTY_CHAR, ...WALL_CHARS]),
    checkLayer(errors, layers.decor, 'decor', width, height, [EMPTY_CHAR, ...Object.keys(DECOR_CHARS)]),
  ].every(Boolean);

  // zones
  const zones = Array.isArray(layout.zones) ? layout.zones : (errors.push('zones must be an array'), []);
  const zoneById = new Map();
  zones.forEach((z, i) => {
    const where = `zones[${i}]`;
    if (!isObj(z) || typeof z.id !== 'string' || !z.id) return errors.push(`${where} needs a string id`);
    if (zoneById.has(z.id)) errors.push(`duplicate zone id '${z.id}'`);
    if (!ZONE_KINDS.includes(z.kind)) errors.push(`zone '${z.id}' has unknown kind '${z.kind}'`);
    const r = z.rect;
    if (!isObj(r) || ![r.x, r.y, r.w, r.h].every(isInt) || r.w < 1 || r.h < 1) {
      return errors.push(`zone '${z.id}' needs a rect {x,y,w,h} of integers`);
    }
    if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) {
      errors.push(`zone '${z.id}' rect is out of bounds`);
    }
    zoneById.set(z.id, z);
  });
  for (const kind of ZONE_KINDS) {
    if (!zones.some((z) => isObj(z) && z.kind === kind)) errors.push(`missing a zone of kind '${kind}'`);
  }

  // props
  const props = Array.isArray(layout.props) ? layout.props : (errors.push('props must be an array'), []);
  let propsOk = true;
  props.forEach((p, i) => {
    const where = `props[${i}]`;
    if (!isObj(p) || !PROP_TYPES.includes(p.type)) {
      propsOk = false;
      return errors.push(`${where} has unknown type '${isObj(p) ? p.type : p}'`);
    }
    if (![p.x, p.y, p.w, p.h].every(isInt) || p.w < 1 || p.h < 1) {
      propsOk = false;
      return errors.push(`${where} (${p.type}) needs integer x, y, w, h`);
    }
    if (p.x < 0 || p.y < 0 || p.x + p.w > width || p.y + p.h > height) {
      propsOk = false;
      errors.push(`${where} (${p.type}) is out of bounds`);
    }
    if (propFrameName(p) === null) {
      propsOk = false;
      errors.push(`${where} (${p.type}) has no sprite for a ${p.w}x${p.h} footprint`);
    }
    if (typeof p.blocking !== 'boolean') {
      propsOk = false;
      errors.push(`${where} (${p.type}) needs a boolean blocking flag`);
    }
  });

  // spots (shape and bounds first; walkability and reachability need the grid)
  const spots = Array.isArray(layout.spots) ? layout.spots : (errors.push('spots must be an array'), []);
  const spotIds = new Set();
  const spotTiles = new Map();
  const shapedSpots = [];
  spots.forEach((s, i) => {
    const where = `spots[${i}]`;
    if (!isObj(s) || typeof s.id !== 'string' || !s.id) return errors.push(`${where} needs a string id`);
    if (spotIds.has(s.id)) errors.push(`duplicate spot id '${s.id}'`);
    spotIds.add(s.id);
    if (!SPOT_KINDS.includes(s.kind)) errors.push(`spot '${s.id}' has unknown kind '${s.kind}'`);
    if (!FACINGS.includes(s.facing)) errors.push(`spot '${s.id}' has unknown facing '${s.facing}'`);
    if (!isInt(s.x) || !isInt(s.y)) return errors.push(`spot '${s.id}' needs integer x and y`);
    if (s.x < 0 || s.y < 0 || s.x >= width || s.y >= height) {
      return errors.push(`spot '${s.id}' is out of bounds (${s.x},${s.y})`);
    }
    const zone = zoneById.get(s.zone);
    if (!zone) errors.push(`spot '${s.id}' refers to unknown zone '${s.zone}'`);
    else if (isObj(zone.rect) && !inRect(zone.rect, s.x, s.y)) {
      errors.push(`spot '${s.id}' lies outside its zone '${s.zone}'`);
    }
    const key = `${s.x},${s.y}`;
    if (spotTiles.has(key)) errors.push(`spots '${spotTiles.get(key)}' and '${s.id}' share tile ${key}`);
    else spotTiles.set(key, s.id);
    shapedSpots.push(s);
  });
  if (!shapedSpots.some((s) => s.kind === 'desk')) errors.push('at least one desk spot is required');

  // spawn
  const sp = layout.spawn;
  if (sp !== undefined && (!isObj(sp) || !isInt(sp.x) || !isInt(sp.y))) {
    errors.push('spawn must be {x, y} of integers');
  } else if (sp && (sp.x < 0 || sp.y < 0 || sp.x >= width || sp.y >= height)) {
    errors.push(`spawn is out of bounds (${sp.x},${sp.y})`);
  }

  if (!layersOk || !propsOk) return errors;
  const grid = buildGrid(layout);
  for (const s of shapedSpots) {
    if (!grid.isWalkable(s.x, s.y)) errors.push(`spot '${s.id}' is on a blocked tile (${s.x},${s.y})`);
  }
  const spawn = spawnOf(layout, grid);
  if (!spawn) {
    errors.push('layout has no walkable tile for the spawn point');
    return errors;
  }
  if (!grid.isWalkable(spawn.x, spawn.y)) {
    errors.push(`spawn is on a blocked tile (${spawn.x},${spawn.y})`);
    return errors;
  }
  const reach = reachableFrom(grid, spawn);
  for (const s of shapedSpots) {
    if (grid.isWalkable(s.x, s.y) && !reach.has(s.y * width + s.x)) {
      errors.push(`${s.kind} spot '${s.id}' is not reachable from the spawn point`);
    }
  }
  return errors;
}

// The spawn tile: layout.spawn, else the first walkable tile in reading order (null if none).
export function spawnOf(layout, grid = buildGrid(layout)) {
  if (layout.spawn) return { x: layout.spawn.x, y: layout.spawn.y };
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) if (grid.isWalkable(x, y)) return { x, y };
  }
  return null;
}

// Validates and returns the layout, or throws a LayoutError listing every problem.
export function parseLayout(layout) {
  const errors = validateLayout(layout);
  if (errors.length) throw new LayoutError(errors);
  return layout;
}

// Picks the layout: the override first, then the bundled one. Both fetchers return the parsed JSON
// or throw; `parse` is the same validator for both (parseLayout). Any override failure (missing,
// unreadable, invalid) is reported through `warn` and falls back to the bundled layout; if the
// bundled one fails too, the error propagates for the readable message.
export async function chooseLayout({ fetchOverride, fetchBundled, parse, warn = () => {} }) {
  try {
    return parse(await fetchOverride());
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
  }
  return parse(await fetchBundled());
}
