'use strict';

// Builds the office atlas: public/office/atlas.png (one RGBA image with every tile, prop and
// character frame) and public/office/atlas.json (the frame map). Node built-ins only, no randomness,
// so the output is byte-for-byte reproducible; a unit test pins the committed files to it.
//
//   node scripts/build-office-atlas.js
//
// Sources: slices of the CC0 Kenney "Roguelike Indoors" sheet (art/kenney-roguelike-indoors/), the
// custom tiles and props in scripts/art/props.js and the chibi characters in scripts/art/characters.js.
// Frame names and the character pose table come from public/js/office/sprite-format.js.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { encodePng, decodePng } = require('./art/png');
const { Img } = require('./art/raster');
const { TILES, PROPS } = require('./art/props');
const { buildLook } = require('./art/characters');

const ROOT = path.join(__dirname, '..');
const OUT = {
  png: path.join(ROOT, 'public', 'office', 'atlas.png'),
  json: path.join(ROOT, 'public', 'office', 'atlas.json'),
};
const KENNEY_SHEET = path.join(
  ROOT,
  'art',
  'kenney-roguelike-indoors',
  'Tilesheets',
  'roguelikeIndoor_transparent.png',
);
const T = 16;
const SHEET_STEP = 17; // 16 px tiles with a 1 px margin
const ATLAS_WIDTH = 512;

// Frames cut from the Kenney sheet: name -> rows of [column, row] tile coordinates.
const KENNEY_FRAMES = {
  'tile.rug': [[[24, 1]]],
  'prop.table.3x2': [
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  ],
  'prop.table.4x2': [
    [
      [0, 0],
      [1, 0],
      [1, 0],
      [2, 0],
    ],
    [
      [0, 1],
      [1, 1],
      [1, 1],
      [2, 1],
    ],
  ],
  // an 11 tile kitchen counter run: cupboards, drawers, hob and dishwasher units
  'prop.counter.11x1': [
    [
      [0, 12],
      [1, 12],
      [0, 12],
      [2, 12],
      [4, 12],
      [0, 12],
      [2, 12],
      [5, 12],
      [0, 12],
      [2, 12],
      [1, 12],
    ],
  ],
  'prop.frame.1x1.0': [[[19, 12]]],
  'prop.frame.1x1.1': [[[19, 13]]],
  'prop.frame.1x1.2': [[[19, 14]]],
};

function loadSheet() {
  const { width, height, pixels } = decodePng(fs.readFileSync(KENNEY_SHEET));
  return Img.fromRgba(width, height, pixels);
}

// The Kenney rug is bright orange; it is recoloured to a deep burgundy (luminance kept) so the
// rugs sit calmly under the furniture. Deterministic integer maths.
function recolourRug(img) {
  const dark = [74, 31, 46];
  const light = [150, 62, 78];
  img.px = img.px.map((p) => {
    if (!p) return p;
    const lum = (p[0] * 3 + p[1] * 6 + p[2]) / 10;
    const k = Math.max(0, Math.min(1, (lum - 60) / 110));
    return [0, 1, 2].map((i) => Math.round(dark[i] + (light[i] - dark[i]) * k)).concat(p[3]);
  });
  return img;
}

function kenneyFrame(sheet, rows) {
  const img = new Img(rows[0].length * T, rows.length * T);
  rows.forEach((row, ry) => {
    row.forEach(([c, r], rx) => img.blit(sheet.crop(c * SHEET_STEP, r * SHEET_STEP, T, T), rx * T, ry * T));
  });
  return img;
}

// Every frame as { name, img, ax, ay }, in a stable order.
function collectFrames(fmt) {
  const sheet = loadSheet();
  const frames = [];
  const seen = new Set();
  const add = (name, img, ax, ay) => {
    if (seen.has(name)) throw new Error(`duplicate frame '${name}'`);
    seen.add(name);
    frames.push({ name, img, ax, ay });
  };

  for (const name of fmt.TILE_NAMES) {
    if (name === 'tile.rug') add(name, recolourRug(kenneyFrame(sheet, KENNEY_FRAMES[name])), 0, 0);
    else if (KENNEY_FRAMES[name]) add(name, kenneyFrame(sheet, KENNEY_FRAMES[name]), 0, 0);
    else if (TILES[name]) add(name, TILES[name](), 0, 0);
    else throw new Error(`no source for tile frame '${name}'`);
  }
  for (const name of fmt.propFrameNames()) {
    if (KENNEY_FRAMES[name]) {
      const img = kenneyFrame(sheet, KENNEY_FRAMES[name]);
      add(name, img, 0, img.h);
    } else if (PROPS[name]) {
      const { img, ax, ay } = PROPS[name]();
      add(name, img, ax, ay);
    } else throw new Error(`no source for prop frame '${name}'`);
  }
  for (const id of fmt.INDICATOR_IDS) {
    const name = fmt.indicatorFrameName(id);
    if (!PROPS[name]) throw new Error(`no source for icon frame '${name}'`);
    const { img, ax, ay } = PROPS[name]();
    add(name, img, ax, ay);
  }
  const looks = [...fmt.ROLES, fmt.FALLBACK_LOOK];
  for (const look of looks) {
    const built = buildLook(look, fmt);
    for (const name of fmt.lookFrameNames(look)) {
      const img = built.get(name);
      if (!img) throw new Error(`no source for character frame '${name}'`);
      if (name === fmt.portraitFrameName(look)) add(name, img, fmt.CHAR_AX, img.h);
      else add(name, img, fmt.CHAR_AX, fmt.CHAR_AY);
    }
  }
  const unused = [...Object.keys(KENNEY_FRAMES), ...Object.keys(PROPS), ...Object.keys(TILES)].filter(
    (n) => !seen.has(n),
  );
  if (unused.length) throw new Error(`frame sources without a frame name: ${unused.join(', ')}`);
  return frames;
}

// Shelf packing: tallest first (then widest, then name), left to right in rows of ATLAS_WIDTH.
function pack(frames) {
  const order = [...frames].sort(
    (a, b) => b.img.h - a.img.h || b.img.w - a.img.w || (a.name < b.name ? -1 : 1),
  );
  let x = 0;
  let y = 0;
  let rowH = 0;
  const placed = [];
  for (const f of order) {
    if (x + f.img.w > ATLAS_WIDTH) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    placed.push({ ...f, x, y });
    x += f.img.w;
    rowH = Math.max(rowH, f.img.h);
  }
  return { placed, width: ATLAS_WIDTH, height: y + rowH };
}

async function buildAtlas() {
  const fmt = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'office', 'sprite-format.js')).href);
  const { placed, width, height } = pack(collectFrames(fmt));
  const atlas = new Img(width, height);
  for (const f of placed) atlas.blit(f.img, f.x, f.y);
  const lines = [...placed]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(
      (f) =>
        `    ${JSON.stringify(f.name)}: { "x": ${f.x}, "y": ${f.y}, "w": ${f.img.w}, "h": ${f.img.h}, "ax": ${f.ax}, "ay": ${f.ay} }`,
    );
  const json =
    `{\n  "version": ${fmt.ATLAS_VERSION},\n  "image": "atlas.png",\n  "width": ${width},\n  "height": ${height},\n` +
    `  "tileSize": ${T},\n  "frames": {\n${lines.join(',\n')}\n  }\n}\n`;
  return { png: encodePng(width, height, atlas.toRgba()), json };
}

module.exports = { buildAtlas, OUT, KENNEY_SHEET, KENNEY_FRAMES };

if (require.main === module) {
  buildAtlas().then(({ png, json }) => {
    fs.mkdirSync(path.dirname(OUT.png), { recursive: true });
    fs.writeFileSync(OUT.png, png);
    fs.writeFileSync(OUT.json, json);
    console.log(
      `wrote ${path.relative(process.cwd(), OUT.png)} and ${path.relative(process.cwd(), OUT.json)}`,
    );
  });
}
