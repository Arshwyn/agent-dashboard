'use strict';

// Chibi characters for the office atlas: one fixed look per role plus one fallback look. Everything
// is hand-defined pixel maps (strings of palette letters) composed by code, so the output is
// deterministic: no randomness, no per-id hashing. Original work (CC0).
//
// A frame is a 16 x 20 cell with the foot point at (8, 18). A look is the shared body templates
// plus a spec { skin, hair, hairStyle, outfit, accent, accessory, detail }; each colour gets a
// base, a shade and a highlight, and every shape has a dark outline.
//
// Palette letters: o outline, s skin, t blush, h hair, i hair shade, j hair highlight, u outfit,
// v outfit shade, w outfit highlight, a accent, b accent shade, c accent highlight, e eye, W white,
// k shoe, g gold, G gold shade, l lens, L lens glint, r red, d dark grey, z sleep mark.

const { Img, shade, toColour } = require('./raster');

const OUTLINE = '#2a2438';

// "mirror" helper: a left half written as a string gives the full symmetrical row.
const sym = (half) => half + [...half].reverse().join('');

// ---- body templates -----------------------------------------------------------------------------

const HEAD = {
  down: [
    '..oooooooo..',
    '.ohhhhjhhho.',
    'ohhhhhhhhhho',
    'ohhhhhhhhhho',
    'ohssssssssho',
    'ossWesseWsso',
    'osseesseesso',
    'ostsssssstso',
    '..oooooooo..',
  ],
  up: [
    '..oooooooo..',
    '.ohhhhjhhho.',
    'ohhhhhhhhhho',
    'ohhhhhhhhhho',
    'ohhhhhhhhhho',
    'ohhhhhhhhhho',
    'ohhhhhhhhhho',
    '.ohhhssshho.',
    '..oooooooo..',
  ],
  right: [
    '..oooooooo..',
    '.ohhhhjhhho.',
    'ohhhhhhhhhho',
    'ohhhhhhhhhho',
    'ohhhhhhsssso',
    'ohhhhhssWeso',
    'ohhhhhssseso',
    'ohhhhhsstsso',
    '..oooooooo..',
  ],
};
const HEAD_CLOSED_EYES = [...HEAD.down];
HEAD_CLOSED_EYES[5] = 'osssssssssso';
HEAD_CLOSED_EYES[6] = 'osseesseesso';

// Hair style changes: rows are edited (column, row) -> letter, and `extra` maps are drawn above.
const HAIR_STYLES = {
  short: {},
  long: {
    down: {
      cells: [
        [1, 5],
        [1, 6],
        [1, 7],
        [10, 5],
        [10, 6],
        [10, 7],
      ],
      letter: 'h',
    },
    right: {
      cells: [
        [1, 5],
        [2, 5],
        [3, 5],
        [1, 6],
        [2, 6],
        [3, 6],
        [1, 7],
        [2, 7],
        [3, 7],
        [4, 7],
      ],
      letter: 'h',
    },
    up: {
      cells: [
        [2, 8],
        [3, 8],
        [4, 8],
        [5, 8],
        [6, 8],
        [7, 8],
        [8, 8],
        [9, 8],
      ],
      letter: 'i',
    },
  },
  bun: { extra: { ox: 4, oy: -2, rows: ['.oo.', 'ohho'] } },
  spiky: { extra: { ox: 1, oy: -2, rows: ['.h..j..h..', 'hhh.hhhhhh'] } },
  tuft: { extra: { ox: 5, oy: -2, rows: ['.j.', 'jhj'] } },
};

// Accessories: arrays of layers { ox, oy, rows } in head coordinates (the head's top-left is 0, 0).
const ACCESSORIES = {
  mortarboard: {
    all: [
      {
        ox: -1,
        oy: -2,
        rows: [
          '..cccccccccc..',
          '.aaaaaaaaaaaa.',
          'bbbbbbbbbbbbbg',
          '.oaaaaaaaaaaog',
          '.oaaaaaaaaaaog',
          '.............G',
        ],
      },
    ],
  },
  headphones: {
    all: [
      {
        ox: -1,
        oy: -1,
        rows: [
          '..dddddddddd..',
          '.d..........d.',
          '.d..........d.',
          '.d..........d.',
          'cc..........cc',
          'aa..........aa',
          'aa..........aa',
          'bb..........bb',
        ],
      },
    ],
    right: [
      {
        ox: -1,
        oy: -1,
        rows: ['..dddddddddd..', '.d..........d.', '.d..........d.', '.d..........d.'],
      },
      { ox: 3, oy: 3, rows: ['cc', 'aa', 'aa', 'bb'] },
    ],
  },
  goggles: {
    down: [{ ox: -1, oy: 1, rows: ['.oaaaaaaaaaao.', '.aLllaaaaLlla.', '.alllaaaalllla'] }],
    up: [{ ox: -1, oy: 1, rows: ['.oaaaaaaaaaao.', '.aaaaaaaaaaaa.'] }],
    right: [{ ox: -1, oy: 1, rows: ['.oaaaaaaaaaao.', '.aaaaaaaaLlla.', '.aaaaaaaallla.'] }],
  },
  cap: {
    all: [
      {
        ox: -1,
        oy: -2,
        rows: [sym('...aaaa'), sym('.aaaaaa'), sym('.aaaaaa'), sym('.oaaaaa'), sym('bbbbbbb')],
      },
      { ox: 5, oy: 0, rows: ['gg', 'gg'] },
    ],
    up: [
      {
        ox: -1,
        oy: -2,
        rows: [sym('...aaaa'), sym('.aaaaaa'), sym('.aaaaaa'), sym('.oaaaaa'), sym('.oaaaaa')],
      },
    ],
  },
  beret: {
    all: [
      {
        ox: -1,
        oy: -2,
        rows: [sym('......a'), sym('...aaaa'), sym('.aaaccc'), sym('.aaaaaa'), sym('.bbbbbb')],
      },
    ],
  },
  monocle: {
    down: [
      { ox: 6, oy: 4, rows: ['gggg', 'g..g', 'g..g', 'gggg'] },
      { ox: 10, oy: 8, rows: ['g', 'g'] },
    ],
    up: [{ ox: 0, oy: 3, rows: ['dddddddddddd'] }],
    right: [{ ox: 7, oy: 4, rows: ['gggg', 'g..g', 'g..g', 'gggg'] }],
  },
  bandana: {
    all: [
      {
        ox: -1,
        oy: 0,
        rows: ['.aaaaaaaaaaaa.', '.acaacaacaaca.', '.baaaaaaaaaab.', '..bbbbbbbbbb..'],
      },
    ],
    knot: { ox: 12, oy: 1, rows: ['.a', 'aa', 'ab', '.b'] },
  },
  hardhat: {
    all: [
      {
        ox: -1,
        oy: -2,
        rows: [sym('....aaa'), sym('..aaaaa'), sym('.aaaaaa'), sym('.oaaaaa'), sym('bbbbbbb')],
      },
      { ox: 5, oy: -2, rows: ['cc', 'cc', 'cc', 'cc'] },
    ],
  },
  wizard: {
    all: [
      {
        ox: -1,
        oy: -2,
        rows: ['.......aa.....', '....aaaaaa....', '...aaaagaaa...', sym('.oaaaaa'), sym('bbbbbbb')],
      },
    ],
  },
};

const BODY = {
  down: ['.ouuwwuuo.', 'ouuuuuuuuo', 'ouuuuuuuuo', 'ouuuuuuuuo', 'ovvvvvvvvo'],
  up: ['.ouuuuuuo.', 'ouuuuuuuuo', 'ouuuuuuuuo', 'ouuuuuuuuo', 'ovvvvvvvvo'],
  right: ['.ouuuuo.', 'ouuuuuuo', 'ouuuuuuo', 'ouuuuuuo', 'ovvvvvvo'],
};

// ---- looks --------------------------------------------------------------------------------------

const LOOK_SPECS = {
  spec: {
    skin: '#f1c9a5',
    hair: '#2b2233',
    hairStyle: 'short',
    outfit: '#2c3e8f',
    accent: '#2c3e8f',
    accessory: 'mortarboard',
    detail: 'robe',
  },
  code: {
    skin: '#d9a066',
    hair: '#6b3f1d',
    hairStyle: 'spiky',
    outfit: '#3fa66b',
    accent: '#3fa66b',
    accessory: 'headphones',
    detail: 'hoodie',
  },
  cleanup: {
    skin: '#c98d5e',
    hair: '#3a2a22',
    hairStyle: 'short',
    outfit: '#7a6a58',
    accent: '#e8893a',
    accessory: 'bandana',
    detail: 'apron',
  },
  'server-ops': {
    skin: '#eac09a',
    hair: '#4a3a2a',
    hairStyle: 'short',
    outfit: '#3b4a5c',
    accent: '#ffd23f',
    accessory: 'hardhat',
    detail: 'hivis',
  },
  ask: {
    skin: '#f0c8a0',
    hair: '#d8d8e8',
    hairStyle: 'long',
    outfit: '#7a4bd6',
    accent: '#7a4bd6',
    accessory: 'wizard',
    detail: 'none',
  },
  verify: {
    skin: '#e6b48a',
    hair: '#1f7a72',
    hairStyle: 'spiky',
    outfit: '#2fb5a8',
    accent: '#e8f7f4',
    accessory: 'goggles',
    detail: 'labcoat',
  },
  review: {
    skin: '#c58a62',
    hair: '#a02a3c',
    hairStyle: 'bun',
    outfit: '#7d2a4f',
    accent: '#e0a43a',
    accessory: 'cap',
    detail: 'tie',
  },
  fallback: {
    skin: '#e8c4a0',
    hair: '#6a4a3a',
    hairStyle: 'tuft',
    outfit: '#8a8fa3',
    accent: '#8a8fa3',
    accessory: null,
    detail: 'none',
  },
};

function paletteFor(spec) {
  const blush = (c) => {
    const [r, g, b] = toColour(c);
    return [Math.round((r + 232) / 2), Math.round((g + 160) / 2), Math.round((b + 140) / 2), 255];
  };
  return {
    o: toColour(OUTLINE),
    s: toColour(spec.skin),
    t: blush(spec.skin),
    h: toColour(spec.hair),
    i: shade(spec.hair, -30),
    j: shade(spec.hair, 35),
    u: toColour(spec.outfit),
    v: shade(spec.outfit, -30),
    w: shade(spec.outfit, 25),
    a: toColour(spec.accent),
    b: shade(spec.accent, -30),
    c: shade(spec.accent, 35),
    e: toColour('#1b1b2b'),
    W: toColour('#ffffff'),
    k: toColour('#3a3f55'),
    g: toColour('#ffd23f'),
    G: toColour('#c9a02a'),
    l: toColour('#8fd3f2'),
    L: toColour('#ffffff'),
    r: toColour('#d6453b'),
    d: toColour('#2b2f40'),
    z: toColour('#e8ecff'),
  };
}

// ---- composition --------------------------------------------------------------------------------

function paintHead(cell, hx, hy, spec, pal, dir, { closed = false } = {}) {
  const rows = (dir === 'down' && closed ? HEAD_CLOSED_EYES : HEAD[dir]).map((r) => r.split(''));
  const style = HAIR_STYLES[spec.hairStyle] || {};
  const edit = style[dir];
  if (edit)
    for (const [x, y] of edit.cells) if (rows[y] && rows[y][x] !== undefined) rows[y][x] = edit.letter;
  cell.map(
    rows.map((r) => r.join('')),
    pal,
    hx,
    hy,
  );
  if (style.extra) cell.map(style.extra.rows, pal, hx + style.extra.ox, hy + style.extra.oy);
  const acc = spec.accessory && ACCESSORIES[spec.accessory];
  if (acc) {
    for (const layer of acc[dir] || acc.all || []) cell.map(layer.rows, pal, hx + layer.ox, hy + layer.oy);
    if (acc.knot) cell.map(acc.knot.rows, pal, hx + acc.knot.ox, hy + acc.knot.oy);
  }
}

function paintDetail(cell, bx, by, spec, pal, dir) {
  const front = dir === 'down';
  const side = dir === 'right';
  const px = (x, y, l) => cell.set(bx + x, by + y, pal[l]);
  const row = (x0, x1, y, l) => {
    for (let x = x0; x <= x1; x++) px(x, y, l);
  };
  const lastX = side ? 6 : 8;
  switch (spec.detail) {
    case 'robe':
      row(2, lastX - 1, 0, 'g');
      row(1, lastX, 4, 'g');
      if (front) {
        px(4, 1, 'g');
        px(5, 1, 'g');
      }
      break;
    case 'hoodie':
      if (front) {
        row(2, 7, 3, 'v');
        px(3, 1, 'W');
        px(6, 1, 'W');
        px(3, 2, 'W');
        px(6, 2, 'W');
      } else if (!side) row(1, 8, 0, 'v');
      else row(1, 3, 1, 'v');
      break;
    case 'labcoat':
      if (front) {
        row(4, 5, 0, 'W');
        row(4, 5, 1, 'W');
        px(4, 2, 'W');
        px(5, 2, 'W');
        for (let y = 0; y < 5; y++) {
          px(3, y, 'v');
          px(6, y, 'v');
        }
      } else if (!side) row(1, 8, 1, 'w');
      break;
    case 'badge':
      if (front) {
        px(2, 1, 'g');
        px(3, 1, 'g');
        px(2, 2, 'G');
        px(3, 2, 'G');
        row(4, 5, 0, 'w');
      } else if (side) px(5, 1, 'g');
      break;
    case 'scarf':
      row(1, lastX, 0, 'a');
      if (front) {
        row(5, 6, 1, 'a');
        row(5, 6, 2, 'b');
      }
      break;
    case 'tie':
      if (front) {
        row(4, 5, 0, 'W');
        px(4, 1, 'r');
        px(5, 1, 'r');
        px(4, 2, 'r');
        px(5, 2, 'r');
        px(4, 3, 'r');
      }
      break;
    case 'apron':
      if (front) {
        for (let y = 2; y < 5; y++) row(2, 7, y, 'a');
        row(2, 7, 2, 'c');
        px(4, 3, 'b');
        px(5, 3, 'b');
        px(2, 1, 'a');
        px(7, 1, 'a');
      } else if (!side) row(2, 7, 2, 'a');
      else row(2, 5, 2, 'a');
      break;
    case 'hivis':
      row(1, lastX, 2, 'a');
      if (!side) {
        for (let y = 0; y < 2; y++) {
          px(3, y, 'a');
          px(6, y, 'a');
        }
      }
      break;
    default:
  }
}

function shadow(cell) {
  cell.rect(4, 17, 8, 1, [0, 0, 0, 55]);
  cell.rect(5, 18, 6, 1, [0, 0, 0, 40]);
}

// Hands as 1x2 skin pixels, sleeves already part of the body map.
function hands(cell, bx, by, pal, ys) {
  cell.rect(bx + 1, by + ys[0], 1, 1, pal.s);
  cell.rect(bx + 8, by + ys[1], 1, 1, pal.s);
}

function feetFront(cell, bx, y, pal, lift) {
  // lift: [left, right] lifted by one pixel (the lifted shoe loses its lower row)
  const shoe = (x, up) => {
    cell.rect(bx + x, y - (up ? 1 : 0), 3, 1, pal.k);
    if (!up) cell.rect(bx + x, y + 1, 3, 1, pal.o);
    else cell.rect(bx + x, y, 3, 1, pal.o);
  };
  shoe(1, lift[0]);
  shoe(6, lift[1]);
}

function feetSide(cell, bx, y, pal, back, front) {
  // back/front: x of the left edge of each shoe (4 wide)
  for (const [x, up] of [back, front]) {
    cell.rect(bx + x, y - (up ? 1 : 0), 4, 1, pal.k);
    cell.rect(bx + x, y + (up ? 0 : 1), 4, 1, pal.o);
  }
}

// One frame of one look. `spec`/`pal` come from the look; returns a 16 x 20 Img.
function frame(spec, pal, pose, dir, n) {
  const cell = new Img(16, 20);
  const standing = ['walk', 'idle', 'celebrate', 'drink', 'stretch', 'reach', 'water'].includes(pose);
  if (standing) shadow(cell);
  const body = (bdir) => BODY[bdir];

  if (pose === 'walk' || pose === 'idle') {
    const bob = pose === 'walk' ? [0, -1, 0, -1][n] : n === 1 ? 1 : 0; // idle: breathe down one pixel
    const headY = 2 + (pose === 'idle' && n === 1 ? 1 : 0) + (pose === 'walk' ? bob : 0);
    const bodyY = 11 + (pose === 'idle' && n === 1 ? 1 : 0) + (pose === 'walk' ? bob : 0);
    if (dir === 'right') {
      const bx = 4;
      if (pose === 'walk') {
        const stride = [
          [
            [0, false],
            [4, false],
          ],
          [
            [2, false],
            [2, true],
          ],
          [
            [4, false],
            [0, false],
          ],
          [
            [2, true],
            [2, false],
          ],
        ][n];
        feetSide(cell, bx, 16, pal, ...stride);
      } else feetSide(cell, bx, 16, pal, [2, false], [2, false]);
      cell.map(body('right'), pal, bx, bodyY);
      const arm = pose === 'walk' ? [-1, 0, 1, 0][n] : 0;
      cell.rect(bx + 3 + arm, bodyY + 1, 2, 2, pal.w);
      cell.rect(bx + 3 + arm, bodyY + 3, 2, 1, pal.s);
      paintDetail(cell, bx, bodyY, spec, pal, 'right');
      paintHead(cell, 2, headY, spec, pal, 'right');
      return cell;
    }
    const bx = 3;
    const lifts =
      pose === 'walk'
        ? [
            [true, false],
            [false, false],
            [false, true],
            [false, false],
          ][n]
        : [false, false];
    feetFront(cell, bx, 16, pal, lifts);
    cell.map(body(dir), pal, bx, bodyY);
    const swing =
      pose === 'walk'
        ? [
            [2, 4],
            [3, 4],
            [4, 2],
            [4, 3],
          ][n]
        : [3, 3];
    hands(cell, bx, bodyY, pal, swing);
    paintDetail(cell, bx, bodyY, spec, pal, dir);
    paintHead(cell, 2, headY, spec, pal, dir);
    return cell;
  }

  if (pose === 'type' || pose === 'alert' || pose === 'sit' || pose === 'sleep') {
    const bx = 3;
    const by = pose === 'sleep' ? 14 : 13;
    const hy = pose === 'sleep' ? 6 : 4;
    const bdir = pose === 'sit' || pose === 'sleep' ? 'down' : 'up';
    cell.map(body(bdir), pal, bx, by);
    paintDetail(cell, bx, by, spec, pal, bdir);
    if (pose === 'type') {
      const f = n === 0;
      cell.rect(bx - 1, by + (f ? 1 : 2), 2, 2, pal.w); // forearms on the keys
      cell.rect(bx + 9, by + (f ? 2 : 1), 2, 2, pal.w);
      cell.rect(bx - 1, by + (f ? 0 : 1), 2, 1, pal.s);
      cell.rect(bx + 9, by + (f ? 1 : 0), 2, 1, pal.s);
    } else if (pose === 'alert') {
      const hx = 14 + (n === 0 ? 0 : -1);
      cell.rect(bx + 9, by - 4, 2, 5, pal.u); // raised arm
      cell.rect(bx + 9, by - 4, 1, 5, pal.w);
      cell.rect(hx, by - 6, 2, 2, pal.s);
      cell.rect(bx - 1, by + 1, 2, 2, pal.w);
    } else {
      hands(cell, bx, by, pal, [3, 3]); // sit and sleep: hands in the lap
    }
    paintHead(cell, 2, hy, spec, pal, bdir, { closed: pose === 'sleep' });
    if (pose === 'sleep') {
      const zs =
        n === 0
          ? [[13, 4]]
          : [
              [13, 2],
              [11, 5],
            ];

      for (const [x, y] of zs) cell.map(['zz', '.z', 'zz'], pal, Math.min(x, 14), y);
    }
    return cell;
  }

  if (pose === 'celebrate' || pose === 'stretch') {
    const crouch = n === 1 && pose === 'celebrate' ? 1 : 0;
    const bx = 3;
    const bodyY = 11 + crouch;
    feetFront(cell, bx, 16, pal, [false, false]);
    cell.map(body('down'), pal, bx, bodyY);
    paintDetail(cell, bx, bodyY, spec, pal, 'down');
    if (pose === 'celebrate') {
      const up = n === 0;
      // both arms raised in a V (frame 0) or flung out wide (frame 1)
      for (const side of [0, 1]) {
        const x = side ? bx + 9 : bx - 1;
        const dx = side ? 1 : -1;
        if (up) {
          cell.rect(x + (side ? 1 : 0), bodyY - 4, 2, 5, pal.u);
          cell.rect(x + (side ? 1 : 0), bodyY - 6, 2, 2, pal.s);
        } else {
          cell.rect(x + dx, bodyY - 1, 2, 3, pal.u);
          cell.rect(x + dx, bodyY - 3, 2, 2, pal.s);
        }
      }
    } else {
      const wide = n === 1;
      for (const side of [0, 1]) {
        const x = side ? bx + 9 : bx - 1;
        if (!wide) {
          cell.rect(x + (side ? 1 : 0), bodyY - 5, 2, 6, pal.u);
          cell.rect(x + (side ? 1 : 0), bodyY - 7, 2, 2, pal.s);
        } else {
          cell.rect(x + (side ? 1 : -1), bodyY + 1, 2, 2, pal.u);
          cell.rect(x + (side ? 3 : -3), bodyY + 1, 2, 2, pal.s);
        }
      }
    }
    paintHead(cell, 2, 2 + crouch, spec, pal, 'down');
    return cell;
  }

  if (pose === 'drink') {
    const bx = 3;
    feetFront(cell, bx, 16, pal, [false, false]);
    cell.map(body('down'), pal, bx, 11);
    paintDetail(cell, bx, 11, spec, pal, 'down');
    cell.rect(bx - 1, 12, 2, 2, pal.w); // left arm at the side
    const lift = n === 1 ? 2 : 0; // the mug tips up toward the mouth on frame 1
    cell.rect(bx + 8, 10 - lift, 2, 3, pal.u); // right arm bent up
    cell.rect(bx + 8, 9 - lift, 2, 1, pal.s);
    cell.rect(bx + 10, 7 - lift, 4, 4, pal.o);
    cell.rect(bx + 11, 8 - lift, 2, 2, pal.W);
    cell.set(bx + 12, 5 - lift - (n === 1 ? 0 : 1), pal.z);
    paintHead(cell, 2, 2, spec, pal, 'down');
    return cell;
  }
  if (pose === 'reach' || pose === 'water') {
    // back view like idle.up / type.up (same hair and accessory), with one arm out
    const bx = 3;
    const bodyY = 11;
    feetFront(cell, bx, 16, pal, [false, false]);
    cell.map(body('up'), pal, bx, bodyY);
    paintDetail(cell, bx, bodyY, spec, pal, 'up');
    cell.rect(bx + 1, bodyY + 3, 1, 1, pal.s); // left hand at the side
    paintHead(cell, 2, 2, spec, pal, 'up');
    if (pose === 'reach') {
      const lift = n === 1 ? 1 : 0; // the hand taps a pixel higher on frame 1
      cell.rect(bx + 9, bodyY - 3 - lift, 2, 5 + lift, pal.u); // raised right arm
      cell.rect(bx + 9, bodyY - 3 - lift, 1, 5 + lift, pal.w);
      cell.rect(bx + 9, bodyY - 5 - lift, 2, 2, pal.s);
    } else {
      cell.rect(bx + 8, bodyY + 1, 2, 2, pal.u); // arm out to the side
      cell.rect(bx + 8, bodyY + 1, 2, 1, pal.w);
      const cy = bodyY + 1 + (n === 1 ? 1 : 0); // the can tilts one pixel on frame 1
      cell.rect(bx + 10, cy - 1, 1, 1, pal.s); // hand on the handle
      cell.rect(bx + 10, cy, 3, 2, pal.l); // can body (3x2, two tones: white rim, blue body)
      cell.rect(bx + 10, cy, 3, 1, pal.W); // rim
    }
    return cell;
  }

  throw new Error(`unknown pose ${pose}`);
}

function portrait(spec, pal) {
  const cell = new Img(16, 16);
  cell.map(BODY.down, pal, 3, 12);
  paintDetail(cell, 3, 12, spec, pal, 'down');
  paintHead(cell, 2, 3, spec, pal, 'down');
  return cell;
}

// Builds every frame of a look: Map(frame name -> Img). `fmt` is the loaded sprite-format module.
function buildLook(look, fmt) {
  const spec = LOOK_SPECS[look];
  if (!spec) throw new Error(`no spec for look '${look}'`);
  const pal = paletteFor(spec);
  const frames = new Map();
  for (const [pose, { dirs, frames: count }] of Object.entries(fmt.POSES)) {
    for (const dir of dirs) {
      for (let n = 0; n < count; n++)
        frames.set(fmt.charFrameName(look, pose, dir, n), frame(spec, pal, pose, dir, n));
    }
  }
  frames.set(fmt.portraitFrameName(look), portrait(spec, pal));
  return frames;
}

module.exports = { buildLook, LOOK_SPECS };
