'use strict';

// The office art pipeline: the committed atlas equals the generator output, the atlas parser, the
// frames the layout and the ten looks need, and the licence file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { decodePng } = require('../scripts/art/png');

const ROOT = path.join(__dirname, '..');
const ATLAS_PNG = path.join(ROOT, 'public', 'office', 'atlas.png');
const ATLAS_JSON = path.join(ROOT, 'public', 'office', 'atlas.json');
const LAYOUT = path.join(ROOT, 'public', 'office', 'layout.json');
const KENNEY = path.join(ROOT, 'art', 'kenney-roguelike-indoors');

const atlasMod = () => import('../public/js/office/atlas.js');
const fmtMod = () => import('../public/js/office/sprite-format.js');
const rolesMod = () => import('../public/js/office/roles.js');
const layoutFmt = () => import('../public/js/office/layout-format.js');
const clone = (o) => JSON.parse(JSON.stringify(o));
const realAtlas = () => JSON.parse(fs.readFileSync(ATLAS_JSON, 'utf8'));
const realLayout = () => JSON.parse(fs.readFileSync(LAYOUT, 'utf8'));
const pngSize = () => {
  const b = fs.readFileSync(ATLAS_PNG);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

const ROLES = ['spec', 'code', 'cleanup', 'server-ops', 'ask', 'verify', 'review'];

// ---- assets and licences ----------------------------------------------------------------------

test('the committed atlas.png and atlas.json equal the generator output, and the old tile strip is gone', async () => {
  const { buildAtlas, OUT } = require('../scripts/build-office-atlas');
  const built = await buildAtlas();
  assert.ok(built.png.equals(fs.readFileSync(OUT.png)), 'run: node scripts/build-office-atlas.js');
  assert.equal(built.json, fs.readFileSync(OUT.json, 'utf8'), 'run: node scripts/build-office-atlas.js');
  assert.equal(OUT.png, ATLAS_PNG);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', 'office', ['tiles', 'png'].join('.'))), false);
});

test('the generator is deterministic: two runs give byte-equal output', async () => {
  const { buildAtlas } = require('../scripts/build-office-atlas');
  const a = await buildAtlas();
  const b = await buildAtlas();
  assert.ok(a.png.equals(b.png));
  assert.equal(a.json, b.json);
});

test('the Kenney sheet is committed unmodified (sha256 pinned) with its licence and source notes', () => {
  const sheet = path.join(KENNEY, 'Tilesheets', 'roguelikeIndoor_transparent.png');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(sheet)).digest('hex');
  assert.equal(sha, 'ade984d5cbe3f16d9e23e6dc516246649de1a7eec2540cf31d53852b690c446f');
  const png = decodePng(fs.readFileSync(sheet));
  assert.deepEqual([png.width, png.height], [458, 305]);
  assert.match(fs.readFileSync(path.join(KENNEY, 'License.txt'), 'utf8'), /Creative Commons Zero, CC0/);
  assert.ok(fs.existsSync(path.join(KENNEY, 'Tilesheets', 'tilesheetInfo.txt')));
  const source = fs.readFileSync(path.join(KENNEY, 'SOURCE.txt'), 'utf8');
  assert.match(source, /578cfdb066c4a9de78a52535adaf953728889b2cf268441bd4d338844f7aa586/);
  assert.match(source, /ade984d5cbe3f16d9e23e6dc516246649de1a7eec2540cf31d53852b690c446f/);
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

test('ASSET-LICENSE lists every art and data file by path and carries the credits', () => {
  const text = fs.readFileSync(path.join(ROOT, 'ASSET-LICENSE'), 'utf8');
  const files = new Set([
    ...walk(path.join(ROOT, 'public', 'office')),
    ...walk(path.join(ROOT, 'art')),
    ...walk(path.join(ROOT, 'scripts', 'art')),
  ]);
  try {
    const tracked = execFileSync('git', ['ls-files', '*.png'], { cwd: ROOT, encoding: 'utf8' });
    for (const f of tracked.split('\n').filter(Boolean)) {
      if (!/^(node_modules|e2e-artifacts|test-results)\//.test(f)) files.add(path.join(ROOT, f));
    }
  } catch {
    // no git checkout (for example a source tarball): the directory walks above still apply
  }
  assert.ok(files.size >= 10);
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    assert.ok(text.includes(rel), `ASSET-LICENSE does not list ${rel}`);
  }
  assert.match(text, /Kenney/);
  assert.match(text, /https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\//);
  assert.match(text, /openclaw-pixel-agents-dashboard/);
  assert.match(text, /MIT/);
  assert.match(text, /https:\/\/kenney\.nl\/assets\/roguelike-indoors/);
  assert.doesNotMatch(text, /placeholder/i);
});

// ---- parseAtlas -------------------------------------------------------------------------------

test('the real atlas.json parses, matches the PNG size, and every frame is inside the image', async () => {
  const { parseAtlas } = await atlasMod();
  const json = realAtlas();
  const atlas = parseAtlas(json);
  const size = pngSize();
  assert.equal(json.width, size.width);
  assert.equal(json.height, size.height);
  assert.equal(json.image, 'atlas.png');
  assert.equal(json.tileSize, 16);
  assert.equal(atlas.count, Object.keys(json.frames).length);
  for (const [name, f] of Object.entries(json.frames)) {
    assert.ok(f.x + f.w <= size.width && f.y + f.h <= size.height, `${name} out of the PNG`);
  }
});

const BAD_ATLAS = [
  ['wrong version', (j) => (j.version = 3), /unsupported version 3/],
  ['missing frame', (j) => delete j.frames['tile.wood'], /missing frame 'tile\.wood'/],
  ['frame out of bounds', (j) => (j.frames['tile.wood'].x = j.width - 4), /out of the \d+x\d+ image bounds/],
  ['non-integer coordinates', (j) => (j.frames['tile.wood'].x = 1.5), /needs integer x, y, w, h, ax, ay/],
  ['anchor outside the frame', (j) => (j.frames['prop.chair'].ay = 99), /anchor outside the frame/],
  [
    'unknown frame name',
    (j) => (j.frames['tile.lava'] = { ...j.frames['tile.wood'] }),
    /unknown frame 'tile\.lava'/,
  ],
  [
    'two names on the same pixels',
    (j) => (j.frames['tile.carpet'] = { ...j.frames['tile.wood'] }),
    /frames '.*' and '.*' overlap/,
  ],
  ['bad dimensions', (j) => (j.width = 0), /width and height/],
];

for (const [name, mutate, message] of BAD_ATLAS) {
  test(`parseAtlas rejects a bad atlas with a clear message: ${name}`, async () => {
    const { parseAtlas, validateAtlas, AtlasError } = await atlasMod();
    const json = clone(realAtlas());
    mutate(json);
    const errors = validateAtlas(json);
    assert.ok(
      errors.some((e) => message.test(e)),
      `${message} not in ${JSON.stringify(errors.slice(0, 3))}`,
    );
    assert.throws(() => parseAtlas(json), AtlasError);
  });
}

test('validateAtlas never throws on junk input', async () => {
  const { validateAtlas } = await atlasMod();
  for (const junk of [
    undefined,
    null,
    5,
    'x',
    [],
    { version: 1 },
    { version: 1, width: 4, height: 4, frames: [] },
  ]) {
    assert.ok(validateAtlas(junk).length > 0);
  }
});

// ---- frames the layout and the looks need -----------------------------------------------------

test('every tile character and prop of the bundled layout resolves to an atlas frame', async () => {
  const { parseAtlas } = await atlasMod();
  const { propFrameName, CHAIR_FRAME } = await fmtMod();
  const { FLOOR_CHARS, DECOR_CHARS } = await layoutFmt();
  const atlas = parseAtlas(realAtlas());
  const layout = realLayout();
  const floors = new Set(layout.layers.floor.join(''));
  for (const c of floors) assert.ok(atlas.has(FLOOR_CHARS[c]), `floor '${c}' -> ${FLOOR_CHARS[c]}`);
  const decor = new Set(layout.layers.decor.join(''));
  for (const c of decor) if (c !== '.') assert.ok(atlas.has(DECOR_CHARS[c]), `decor '${c}'`);
  assert.ok(atlas.has('tile.wall-top') && atlas.has('tile.wall-face'));
  for (const p of layout.props) {
    for (const lit of [false, true]) {
      const name = propFrameName(p, lit);
      assert.ok(name && atlas.has(name), `${p.type} ${p.w}x${p.h} -> ${name}`);
    }
  }
  assert.ok(atlas.has(CHAIR_FRAME));
});

test('propFrameName follows the table: lit desks, variants by position, unknown sizes have no frame', async () => {
  const { propFrameName } = await fmtMod();
  assert.equal(propFrameName({ type: 'desk', x: 4, y: 4, w: 2, h: 1 }), 'prop.desk.2x1');
  assert.equal(propFrameName({ type: 'desk', x: 4, y: 4, w: 2, h: 1 }, true), 'prop.desk.2x1.lit');
  assert.equal(propFrameName({ type: 'beanbag', x: 3, y: 28, w: 1, h: 1 }, true), 'prop.beanbag.1x1.3');
  assert.equal(propFrameName({ type: 'beanbag', x: 4, y: 28, w: 1, h: 1 }), 'prop.beanbag.1x1.0');
  assert.equal(propFrameName({ type: 'desk', x: 0, y: 0, w: 3, h: 1 }), null);
  assert.equal(propFrameName({ type: 'constructor', x: 0, y: 0, w: 1, h: 1 }), null);
});

test('every look has every pose, direction and frame of the table, plus a portrait', async () => {
  const { parseAtlas } = await atlasMod();
  const { POSES, charFrameName, portraitFrameName, lookFrameNames } = await fmtMod();
  const { LOOKS } = await rolesMod();
  const atlas = parseAtlas(realAtlas());
  assert.equal(LOOKS.length, 8);
  for (const look of LOOKS) {
    let count = 0;
    for (const [pose, { dirs, frames }] of Object.entries(POSES)) {
      for (const dir of dirs) {
        for (let n = 0; n < frames; n++) {
          assert.ok(atlas.has(charFrameName(look, pose, dir, n)), `${look} ${pose} ${dir} ${n}`);
          count++;
        }
      }
    }
    assert.equal(count, 35);
    assert.ok(atlas.has(portraitFrameName(look)));
    assert.equal(lookFrameNames(look).length, 36);
    // characters are 16x20 with the foot anchor at (8, 18); portraits are 16x16
    const f = atlas.get(charFrameName(look, 'idle', 'down', 0));
    assert.deepEqual([f.w, f.h, f.ax, f.ay], [16, 20, 8, 18]);
    const p = atlas.get(portraitFrameName(look));
    assert.deepEqual([p.w, p.h], [16, 16]);
  }
  // no left frames: left is the right frame mirrored when drawn
  assert.equal(
    Object.keys(atlas.frames).some((n) => n.includes('.left.')),
    false,
  );
});

test('the eight looks are visually distinct and every frame has pixels', async () => {
  const { charFrameName, portraitFrameName, lookFrameNames } = await fmtMod();
  const { LOOKS } = await rolesMod();
  const json = realAtlas();
  const png = decodePng(fs.readFileSync(ATLAS_PNG));
  const grab = (name) => {
    const f = json.frames[name];
    const out = [];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = ((f.y + y) * png.width + f.x + x) * 4;
        out.push(png.pixels.subarray(i, i + 4).join(','));
      }
    }
    return out;
  };
  const idle = Object.fromEntries(LOOKS.map((l) => [l, grab(charFrameName(l, 'idle', 'down', 0))]));
  const ports = Object.fromEntries(LOOKS.map((l) => [l, grab(portraitFrameName(l))]));
  for (let i = 0; i < LOOKS.length; i++) {
    for (let j = i + 1; j < LOOKS.length; j++) {
      for (const set of [idle, ports]) {
        const diff = set[LOOKS[i]].filter((px, k) => px !== set[LOOKS[j]][k]).length;
        assert.ok(diff >= 12, `${LOOKS[i]} and ${LOOKS[j]} differ in only ${diff} pixels`);
      }
    }
  }
  for (const look of LOOKS) {
    for (const name of lookFrameNames(look)) {
      assert.ok(
        grab(name).some((px) => !px.endsWith(',0')),
        `${name} is empty`,
      );
    }
  }
});

test('poses animate: the frames of a multi-frame pose differ from each other', async () => {
  const { POSES, charFrameName } = await fmtMod();
  const json = realAtlas();
  const png = decodePng(fs.readFileSync(ATLAS_PNG));
  const bytes = (name) => {
    const f = json.frames[name];
    const rows = [];
    for (let y = 0; y < f.h; y++) {
      const i = ((f.y + y) * png.width + f.x) * 4;
      rows.push(png.pixels.subarray(i, i + f.w * 4).toString('hex'));
    }
    return rows.join('');
  };
  for (const [pose, { dirs, frames }] of Object.entries(POSES)) {
    if (frames < 2) continue;
    for (const dir of dirs) {
      const set = new Set();
      for (let n = 0; n < frames; n++) set.add(bytes(charFrameName('code', pose, dir, n)));
      assert.equal(set.size, frames, `${pose}.${dir} frames are not all different`);
    }
  }
});

test('reach and water frames exist for all ten looks, are not empty and differ from idle.up', async () => {
  const { charFrameName } = await fmtMod();
  const { LOOKS } = await rolesMod();
  const json = realAtlas();
  const png = decodePng(fs.readFileSync(ATLAS_PNG));
  const pixels = (name) => {
    const f = json.frames[name];
    const rows = [];
    let opaque = 0;
    for (let y = 0; y < f.h; y++) {
      const i = ((f.y + y) * png.width + f.x) * 4;
      const row = png.pixels.subarray(i, i + f.w * 4);
      for (let k = 3; k < row.length; k += 4) if (row[k] > 0) opaque++;
      rows.push(row.toString('hex'));
    }
    return { key: rows.join(''), opaque };
  };
  for (const look of LOOKS) {
    const idle = pixels(charFrameName(look, 'idle', 'up', 0)).key;
    for (const pose of ['reach', 'water']) {
      for (const n of [0, 1]) {
        const f = pixels(charFrameName(look, pose, 'up', n));
        assert.ok(f.opaque > 60, `${look} ${pose}.${n} is nearly empty`);
        assert.notEqual(f.key, idle, `${look} ${pose}.${n} equals idle.up`);
      }
    }
  }
});

// ---- roles ------------------------------------------------------------------------------------

test('LOOKS is the seven roles plus the fallback; lookFor is fixed and own-property only', async () => {
  const { LOOKS, lookFor } = await rolesMod();
  const { ROLES: FMT_ROLES } = await fmtMod();
  assert.deepEqual(FMT_ROLES, ROLES);
  assert.deepEqual(LOOKS, [...ROLES, 'fallback']);
  for (const r of ROLES) assert.equal(lookFor(r), r);
  for (const id of [
    'orchestrator',
    '',
    undefined,
    null,
    7,
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
  ]) {
    assert.equal(lookFor(id), 'fallback', String(id));
  }
  assert.equal(lookFor('orchestrator'), lookFor('orchestrator'));
  assert.equal(lookFor('some-new-agent'), lookFor('orchestrator'), 'every unknown id shares one look');
});

test('the role list equals the roles of the agent definition files (when they are present)', (t) => {
  const dir = process.env.AGENT_DEFINITIONS_DIR;
  if (!dir || !fs.existsSync(dir))
    return t.skip('set AGENT_DEFINITIONS_DIR to a directory of role .md files');
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  assert.deepEqual([...names].sort(), [...ROLES].sort());
});

test('the four step icons are in the atlas as 8x8 frames with pixels, distinct from each other', async () => {
  const { INDICATOR_IDS, indicatorFrameName } = await fmtMod();
  const { parseAtlas } = await atlasMod();
  assert.deepEqual(INDICATOR_IDS, ['flask', 'brush', 'shield', 'magnifier']);
  const json = realAtlas();
  const atlas = parseAtlas(json);
  const png = decodePng(fs.readFileSync(ATLAS_PNG));
  const keys = INDICATOR_IDS.map((id) => {
    const name = indicatorFrameName(id);
    assert.ok(atlas.has(name), name);
    const f = json.frames[name];
    assert.deepEqual([f.w, f.h, f.ax, f.ay], [8, 8, 4, 8]);
    const px = [];
    let opaque = 0;
    for (let y = 0; y < f.h; y++) {
      const i = ((f.y + y) * png.width + f.x) * 4;
      const row = png.pixels.subarray(i, i + f.w * 4);
      for (let k = 3; k < row.length; k += 4) if (row[k] > 0) opaque++;
      px.push(row.toString('hex'));
    }
    assert.ok(opaque > 15, `${name} is nearly empty`);
    return px.join('');
  });
  assert.equal(new Set(keys).size, 4);
});

// ---- named people looks ---------------------------------------------------------------------------

test('there are sixteen person looks; every frame is in the atlas; personLook cycles', async () => {
  const { parseAtlas } = await atlasMod();
  const { PERSON_LOOKS, personLook, lookFrameNames, FALLBACK_LOOK } = await fmtMod();
  const { lookFor, ALL_LOOKS } = await rolesMod();
  const atlas = parseAtlas(realAtlas());
  assert.equal(PERSON_LOOKS.length, 16);
  assert.equal(ALL_LOOKS.length, 8 + 16);
  for (const look of PERSON_LOOKS) {
    assert.equal(lookFor(look), look);
    for (const name of lookFrameNames(look)) assert.ok(atlas.has(name), name);
  }
  assert.equal(personLook(1), 'person-1');
  assert.equal(personLook(16), 'person-16');
  assert.equal(personLook(17), 'person-1');
  assert.equal(personLook(0), FALLBACK_LOOK);
  assert.equal(personLook(null), FALLBACK_LOOK);
  assert.equal(lookFor('person-17'), FALLBACK_LOOK);
});

test('the person looks differ pairwise in skin, hair or outfit and in their pixels, and from fallback', () => {
  const { PERSON_LOOK_SPECS, LOOK_SPECS } = require('../scripts/art/characters');
  const names = Object.keys(PERSON_LOOK_SPECS);
  assert.equal(names.length, 16);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = PERSON_LOOK_SPECS[names[i]];
      const b = PERSON_LOOK_SPECS[names[j]];
      const same = ['skin', 'hair', 'outfit'].filter((k) => a[k] === b[k]).length;
      assert.ok(same <= 1, `${names[i]} and ${names[j]} share ${same} of skin/hair/outfit`);
    }
    const fb = LOOK_SPECS.fallback;
    const p = PERSON_LOOK_SPECS[names[i]];
    assert.ok(['skin', 'hair', 'outfit'].some((k) => p[k] !== fb[k]));
  }
});

test('person looks are visually distinct in the atlas and the PNG stays small', async () => {
  const { charFrameName, portraitFrameName, PERSON_LOOKS } = await fmtMod();
  const json = realAtlas();
  const png = decodePng(fs.readFileSync(ATLAS_PNG));
  const grab = (name) => {
    const f = json.frames[name];
    const out = [];
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = ((f.y + y) * png.width + f.x + x) * 4;
        out.push(png.pixels.subarray(i, i + 4).join(','));
      }
    }
    return out;
  };
  const look = [...PERSON_LOOKS, 'fallback'];
  for (const make of [(l) => charFrameName(l, 'idle', 'down', 0), portraitFrameName]) {
    const px = Object.fromEntries(look.map((l) => [l, grab(make(l))]));
    for (let i = 0; i < look.length; i++) {
      for (let j = i + 1; j < look.length; j++) {
        const diff = px[look[i]].filter((v, k) => v !== px[look[j]][k]).length;
        assert.ok(diff >= 12, `${look[i]} and ${look[j]} differ in only ${diff} pixels`);
      }
    }
  }
  assert.ok(fs.statSync(ATLAS_PNG).size < 100 * 1024);
});

test('agentLook: a person gets the look of its pool position, a role card its role look, others the fallback', async () => {
  const { agentLook } = await rolesMod();
  assert.equal(agentLook({ id: 'Carl', slot: 3, role: 'spec' }), 'person-3');
  assert.equal(agentLook({ id: 'Extra 9', slot: 17, role: 'code' }), 'person-1', 'larger pools cycle');
  assert.equal(agentLook({ id: 'review', slot: null, role: 'review' }), 'review');
  assert.equal(agentLook({ id: 'orchestrator', slot: null, role: 'orchestrator' }), 'fallback');
  assert.equal(agentLook({ id: 'Ada', slot: 1, role: null }), 'person-1');
  assert.equal(agentLook(null), 'fallback');
});
