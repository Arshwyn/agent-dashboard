'use strict';

// Original (CC0) tiles and props for the office atlas, drawn from code and small string maps so the
// output is deterministic. Each entry of PROPS is { img, ax, ay }: the frame and the offset of the
// bottom-left corner of the prop's tile footprint inside it (props extend upward through ay).
// Tiles and props that come from the Kenney sheet are listed in build-office-atlas.js instead.

const { Img, shade } = require('./raster');

const T = 16;

// ---- helpers ----------------------------------------------------------------------------------

function ellipse(img, cx, cy, rx, ry, c) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) img.set(x, y, c);
    }
  }
}

// Paints `c` on every transparent pixel that touches an opaque one (4-neighbourhood).
function outline(img, c) {
  const marks = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.get(x, y)) continue;
      if (img.get(x - 1, y) || img.get(x + 1, y) || img.get(x, y - 1) || img.get(x, y + 1))
        marks.push([x, y]);
    }
  }
  for (const [x, y] of marks) img.set(x, y, c);
}

// ---- tiles (16 x 16, seamless) ---------------------------------------------------------------

function tileWood() {
  const img = new Img(T, T);
  const base = '#8a6246';
  const dark = '#6c4a36';
  const light = '#99704f';
  img.rect(0, 0, T, T, base);
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    img.rect(0, y + 3, T, 1, dark); // seam under each plank row
    img.rect(0, y, T, 1, light); // lit top edge
    const joint = [5, 12, 8, 2][row]; // staggered end joints
    img.rect(joint, y, 1, 3, dark);
    for (let x = 0; x < T; x++) if ((x * 7 + row * 5) % 11 === 0) img.set(x, y + 1 + (x % 2), light);
  }
  return img;
}

function tileCarpet() {
  const img = new Img(T, T);
  img.rect(0, 0, T, T, '#4d5f7e');
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const v = (x * 5 + y * 9) % 7;
      if (v === 0) img.set(x, y, '#58698a');
      else if (v === 3 && (x + y) % 2) img.set(x, y, '#43546f');
    }
  }
  return img;
}

function tileKitchen() {
  const img = new Img(T, T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
      img.set(x, y, checker ? '#c4ccd9' : '#dde2ea');
    }
  }
  img.rect(0, 0, T, 1, '#a9b3c4');
  img.rect(0, 0, 1, T, '#a9b3c4');
  img.rect(8, 8, 8, 1, '#b7c0cf');
  img.rect(8, 0, 1, 8, '#b7c0cf');
  return img;
}

function tileServer() {
  const img = new Img(T, T);
  img.rect(0, 0, T, T, '#394052');
  img.rect(0, 0, T, 1, '#2b3141');
  img.rect(0, 0, 1, T, '#2b3141');
  img.rect(8, 8, 8, 1, '#2f3647');
  img.rect(8, 0, 1, 8, '#2f3647');
  for (const [x, y] of [
    [3, 3],
    [12, 3],
    [3, 12],
    [12, 12],
  ])
    img.set(x, y, '#4e576d');
  return img;
}

function tileGrass() {
  const img = new Img(T, T);
  img.rect(0, 0, T, T, '#5a9a4e');
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const v = (x * 7 + y * 11) % 13;
      if (v === 0) img.set(x, y, '#6fb95f');
      else if (v === 5 && (x + y) % 3 === 0) img.set(x, y, '#4a8541');
    }
  }
  for (const [x, y] of [
    [3, 4],
    [11, 9],
    [6, 13],
  ]) {
    img.set(x, y, '#7ccf6b');
    img.set(x, y - 1, '#7ccf6b');
  }
  return img;
}

function tileWallTop() {
  const img = new Img(T, T);
  img.rect(0, 0, T, T, '#3f3d5c');
  img.rect(0, 0, T, 2, '#55537a');
  for (let x = 0; x < T; x++) if (x % 5 === 2) img.set(x, 8, '#4a486b');
  return img;
}

function tileWallFace() {
  const img = new Img(T, T);
  img.rect(0, 0, T, T, '#e6d9bd'); // plaster
  for (let y = 4; y < 9; y++)
    for (let x = 0; x < T; x++) if ((x * 3 + y * 5) % 13 === 0) img.set(x, y, '#dccfb2');
  img.rect(0, 0, T, 2, '#3f3d5c'); // dark cap where the wall meets the wall above
  img.rect(0, 2, T, 1, '#b9a98a');
  img.rect(0, 9, T, 1, '#c9b28c'); // wainscot rail
  img.rect(0, 10, T, 3, '#cdb48a');
  img.rect(0, 13, T, 3, '#6a4e3a'); // skirting
  img.rect(0, 13, T, 1, '#80614a');
  return img;
}

const TILES = {
  'tile.wood': tileWood,
  'tile.carpet': tileCarpet,
  'tile.kitchen': tileKitchen,
  'tile.server': tileServer,
  'tile.grass': tileGrass,
  'tile.wall-top': tileWallTop,
  'tile.wall-face': tileWallFace,
};

// ---- props ------------------------------------------------------------------------------------

function desk(lit) {
  const img = new Img(32, 26); // footprint rows 10..25, the monitor rises 10 px above it
  // monitor
  img.rect(10, 0, 12, 9, '#1e2233');
  img.rect(11, 1, 10, 6, lit ? '#5fe3a1' : '#2b3646');
  if (lit) {
    img.rect(12, 2, 6, 1, '#1d6b49');
    img.rect(12, 4, 4, 1, '#1d6b49');
    img.rect(17, 5, 3, 1, '#1d6b49');
    img.rect(11, 1, 10, 1, '#a8f3cf');
  } else img.rect(11, 1, 4, 1, '#3d4a5e');
  img.rect(14, 7, 4, 1, '#1e2233');
  img.rect(15, 8, 2, 2, '#1e2233');
  // desk top
  img.rect(0, 10, 32, 11, '#d6dae4');
  img.rect(0, 10, 32, 1, '#eef0f6');
  img.rect(0, 20, 32, 1, '#9aa1b5');
  img.rect(0, 21, 32, 4, '#7e869c'); // front panel
  img.rect(0, 21, 32, 1, '#6a728a');
  img.rect(1, 25, 2, 1, '#4a5066');
  img.rect(29, 25, 2, 1, '#4a5066');
  img.rect(2, 21, 2, 4, '#4a5066');
  img.rect(28, 21, 2, 4, '#4a5066');
  // keyboard, mouse, mug, papers
  img.rect(11, 14, 9, 3, '#2b3040');
  img.rect(12, 15, 7, 1, '#4a5168');
  img.rect(22, 15, 2, 2, '#2b3040');
  img.rect(26, 12, 3, 3, '#ffffff');
  img.rect(26, 12, 3, 1, '#7b4a2a');
  img.rect(29, 13, 1, 1, '#ffffff');
  img.rect(3, 12, 5, 4, '#f4efe6');
  img.rect(4, 13, 3, 1, '#9aa1b5');
  return { img, ax: 0, ay: 26 };
}

function chair() {
  const img = new Img(T, T);
  img.rect(3, 1, 10, 9, '#3a4160'); // back rest
  img.rect(4, 2, 8, 2, '#5a6490');
  img.rect(3, 1, 10, 1, '#2a3050');
  img.rect(2, 9, 12, 3, '#2f3552'); // seat edge
  img.rect(2, 9, 12, 1, '#4c5578');
  img.rect(7, 12, 2, 2, '#1d2133'); // stem
  img.rect(3, 14, 10, 1, '#1d2133'); // star base
  for (const x of [2, 7, 12]) img.rect(x, 15, 2, 1, '#10131f'); // casters
  return { img, ax: 0, ay: 16 };
}

const BEAN_COLOURS = ['#e0524d', '#4aa3df', '#f2c14e', '#6fbf73'];

function beanbag(c) {
  const img = new Img(T, T);
  const dark = shade(c, -45);
  const mid = shade(c, -18);
  ellipse(img, 8, 10.5, 7, 4.8, c);
  ellipse(img, 8, 7.2, 5, 4.2, c);
  img.rect(3, 12, 10, 2, mid); // shaded lower side
  ellipse(img, 6.5, 5.5, 2, 1.2, shade(c, 35)); // highlight
  outline(img, dark);
  // soft shadow under it
  const out = new Img(T, T);
  out.rect(3, 15, 10, 1, [0, 0, 0, 60]);
  out.blit(img);
  return { img: out, ax: 0, ay: 16 };
}

function coffee() {
  const img = new Img(T, 24); // sits on the counter top: the tile footprint is the lower 16 rows
  img.rect(3, 1, 10, 13, '#3b3f55');
  img.rect(3, 1, 10, 1, '#565b78');
  img.rect(4, 2, 8, 2, '#d7433b');
  img.rect(10, 2, 1, 1, '#ffd23f');
  img.rect(5, 5, 6, 5, '#1b1e2e');
  img.rect(6, 6, 4, 1, '#2f3450');
  img.rect(6, 10, 4, 4, '#f4efe6'); // cup
  img.rect(6, 10, 4, 1, '#7b4a2a');
  img.rect(10, 11, 1, 2, '#f4efe6');
  img.rect(3, 13, 10, 1, '#262a3d');
  return { img, ax: 0, ay: 24 };
}

function whiteboard() {
  const img = new Img(64, 32);
  img.rect(3, 2, 58, 26, '#8d93a6'); // frame
  img.rect(3, 2, 58, 1, '#b6bbcb');
  img.rect(5, 4, 54, 22, '#f6f7fb');
  img.rect(5, 4, 54, 1, '#dfe2ec');
  // scribbles: a flow chart and some lines
  img.rect(9, 8, 10, 6, '#3b6fd6');
  img.rect(10, 9, 8, 4, '#f6f7fb');
  img.rect(19, 10, 8, 1, '#3b6fd6');
  img.rect(27, 8, 10, 6, '#d6453b');
  img.rect(28, 9, 8, 4, '#f6f7fb');
  img.rect(37, 10, 6, 1, '#d6453b');
  img.rect(43, 7, 11, 8, '#2f9e6a');
  img.rect(44, 8, 9, 6, '#f6f7fb');
  for (let i = 0; i < 3; i++) img.rect(9, 18 + i * 3, 30 - i * 7, 1, '#2b2f40');
  img.rect(42, 19, 12, 4, '#ffd23f');
  img.rect(42, 19, 12, 1, '#c9a02a');
  img.rect(10, 28, 44, 2, '#6b7085'); // marker tray
  img.rect(14, 27, 4, 1, '#d6453b');
  img.rect(20, 27, 4, 1, '#3b6fd6');
  img.rect(26, 27, 4, 1, '#2b2f40');
  return { img, ax: 0, ay: 32 };
}

function rack(variant) {
  const img = new Img(T, 36); // two tiles of footprint plus four pixels of cabinet top
  img.rect(1, 1, 14, 35, '#171b29');
  img.rect(1, 1, 14, 1, '#3a4260');
  for (let u = 0; u < 4; u++) {
    const y = 3 + u * 8;
    img.rect(2, y, 12, 7, '#2b3350');
    img.rect(2, y, 12, 1, '#3f4870');
    for (let v = 0; v < 4; v++) img.rect(3 + v * 2, y + 3, 1, 2, '#12162a'); // drive bays
    const on = (u + variant) % 2 === 0;
    img.rect(11, y + 2, 2, 2, on ? '#5fe3a1' : '#2f7a58');
    img.rect(11, y + 4, 2, 1, (u + variant) % 3 === 0 ? '#ff6b81' : '#ffb347');
  }
  img.rect(1, 35, 14, 1, '#0c0f1a');
  return { img, ax: 0, ay: 36 };
}

function windowArt(variant) {
  const img = new Img(32, 32);
  img.rect(2, 1, 28, 26, '#d9dbe8'); // frame
  img.rect(2, 1, 28, 1, '#ffffff');
  const glass = new Img(24, 22); // the scene is drawn on its own so it stays inside the opening
  glass.rect(0, 0, 24, 22, variant ? '#a9dcf2' : '#7fc4ec');
  glass.rect(0, 0, 24, 5, variant ? '#cfeefb' : '#bfe6fa');
  if (variant) {
    // garden view: hills, a tree and a flower bed
    ellipse(glass, 6, 23, 12, 7, '#4aa86a');
    ellipse(glass, 20, 24, 11, 7, '#388f57');
    glass.rect(13, 11, 3, 8, '#7a4a2a');
    ellipse(glass, 14.5, 9, 4, 4, '#2f8f4e');
    ellipse(glass, 13.5, 8, 2, 2, '#46b86a');
    for (const x of [2, 5, 8, 18]) glass.rect(x, 18, 1, 1, '#ff6b81');
  } else {
    glass.rect(4, 7, 8, 2, '#ffffff'); // clouds
    glass.rect(6, 5, 5, 2, '#ffffff');
    glass.rect(15, 12, 6, 2, '#ffffff');
  }
  img.blit(glass, 4, 3);
  img.rect(15, 3, 2, 22, '#d9dbe8'); // mullions
  img.rect(4, 13, 24, 2, '#d9dbe8');
  img.rect(1, 26, 30, 3, '#bfc3d6'); // sill
  img.rect(1, 26, 30, 1, '#e8eaf3');
  img.rect(1, 29, 30, 1, '#8f94ad');
  return { img, ax: 0, ay: 32 };
}

function plantRound() {
  const img = new Img(T, 24);
  img.rect(4, 17, 8, 7, '#a0522d'); // terracotta pot
  img.rect(4, 17, 8, 1, '#c26a3a');
  img.rect(5, 23, 6, 1, '#6b341c');
  img.rect(7, 12, 2, 6, '#2d6a3e');
  ellipse(img, 8, 9, 6, 7, '#2f8f4e');
  ellipse(img, 6, 6, 3, 3.5, '#46b86a');
  ellipse(img, 11, 11, 3, 3, '#277a43');
  img.rect(9, 3, 2, 2, '#7fd99a');
  img.rect(5, 12, 1, 1, '#ff6b81'); // a flower
  return { img, ax: 0, ay: 24 };
}

function plantFern() {
  const img = new Img(T, 24);
  img.rect(4, 17, 8, 7, '#6d7388'); // slate pot
  img.rect(4, 17, 8, 1, '#8e94aa');
  img.rect(5, 23, 6, 1, '#474c60');
  img.rect(4, 18, 8, 1, '#5a5f74');
  // fronds fanning out from the pot
  const fronds = [
    [
      [7, 16],
      [6, 12],
      [4, 8],
      [2, 5],
    ],
    [
      [8, 16],
      [8, 11],
      [8, 6],
      [8, 2],
    ],
    [
      [9, 16],
      [10, 12],
      [12, 8],
      [14, 5],
    ],
    [
      [7, 16],
      [5, 14],
      [3, 12],
      [1, 11],
    ],
    [
      [9, 16],
      [11, 14],
      [13, 12],
      [15, 11],
    ],
  ];
  for (const f of fronds) {
    for (const [x, y] of f) {
      img.rect(x - 1, y, 3, 2, '#2f8f4e');
      img.set(x, y, '#46b86a');
      img.set(x + 1, y + 1, '#277a43');
    }
  }
  return { img, ax: 0, ay: 24 };
}

function plantBush() {
  const img = new Img(T, 20);
  img.rect(4, 13, 8, 7, '#e6e8f0'); // white pot
  img.rect(4, 13, 8, 1, '#ffffff');
  img.rect(4, 19, 8, 1, '#aab0c4');
  ellipse(img, 8, 9, 7, 5, '#388f57');
  ellipse(img, 5, 8, 3, 3, '#46b86a');
  ellipse(img, 11, 9, 3, 3, '#2f8f4e');
  for (const [x, y] of [
    [4, 6],
    [9, 5],
    [12, 9],
    [7, 10],
  ])
    img.set(x, y, '#ffd23f'); // blossoms
  return { img: img, ax: 0, ay: 20 };
}

function confTable() {
  const img = new Img(128, 48);
  img.rect(2, 0, 124, 40, '#9a7352');
  img.rect(0, 2, 128, 36, '#9a7352');
  img.rect(2, 1, 124, 1, '#b48c66');
  img.rect(4, 3, 120, 1, '#b48c66');
  img.rect(0, 38, 128, 4, '#6e4d33'); // front edge
  img.rect(2, 41, 124, 1, '#4f3624');
  img.rect(6, 42, 6, 6, '#4f3624'); // legs
  img.rect(116, 42, 6, 6, '#4f3624');
  img.rect(58, 42, 12, 4, '#4f3624');
  // corner rounding
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [126, 0],
    [127, 0],
    [127, 1],
  ])
    img.set(x, y, null);
  // laptops, mugs, papers
  for (const x of [20, 56, 92]) {
    img.rect(x, 8, 14, 9, '#2a2f44');
    img.rect(x + 1, 9, 12, 6, '#7fc4ec');
    img.rect(x + 2, 10, 6, 1, '#3b6fd6');
    img.rect(x - 1, 17, 16, 2, '#3a4160');
  }
  for (const x of [14, 50, 86, 108]) {
    img.rect(x, 24, 3, 3, '#ffffff');
    img.rect(x, 24, 3, 1, '#7b4a2a');
  }
  for (const x of [30, 70, 102]) {
    img.rect(x, 22, 6, 5, '#f4efe6');
    img.rect(x + 1, 23, 4, 1, '#9aa1b5');
  }
  return { img, ax: 0, ay: 48 };
}

function bookcase() {
  const img = new Img(32, 32);
  img.rect(1, 2, 30, 29, '#7a5638');
  img.rect(1, 2, 30, 1, '#a07652');
  img.rect(3, 4, 26, 25, '#4b3322');
  const books = ['#d6453b', '#3b6fd6', '#e8c14a', '#2f9e6a', '#9b59b6', '#e8893a', '#f4efe6'];
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = 5 + shelf * 8;
    let x = 4;
    let i = shelf * 2;
    while (x < 28) {
      const w = 2 + ((i * 3) % 3);
      const h = 5 + ((i * 5) % 3);
      if (x + w > 28) break;
      img.rect(x, y + 6 - h, w, h, books[i % books.length]);
      img.rect(x, y + 6 - h, w, 1, shade(books[i % books.length], 30));
      x += w;
      i++;
    }
    img.rect(3, y + 6, 26, 2, '#7a5638');
  }
  img.rect(1, 31, 30, 1, '#3d2a1a');
  return { img, ax: 0, ay: 32 };
}

function fridge() {
  const img = new Img(T, 32);
  img.rect(2, 2, 12, 29, '#dfe5ee');
  img.rect(2, 2, 12, 1, '#ffffff');
  img.rect(2, 2, 1, 29, '#f2f5fa');
  img.rect(13, 3, 1, 28, '#aab4c4');
  img.rect(2, 12, 12, 1, '#9aa5b8'); // freezer split
  img.rect(11, 5, 1, 5, '#7b869b'); // handles
  img.rect(11, 15, 1, 9, '#7b869b');
  img.rect(4, 5, 3, 3, '#ffd23f'); // magnets and a note
  img.rect(4, 15, 4, 4, '#f4efe6');
  img.rect(5, 16, 2, 1, '#d6453b');
  img.rect(2, 31, 12, 1, '#7b869b');
  outline(img, '#3d4560');
  return { img: img.crop(0, 0, T, 32), ax: 0, ay: 32 };
}

function cooler() {
  const img = new Img(T, 24);
  ellipse(img, 8, 6, 5, 5.5, '#9fd8f5'); // jug
  img.rect(4, 5, 8, 6, '#9fd8f5');
  img.rect(5, 3, 2, 5, '#d4effb');
  img.rect(5, 12, 6, 2, '#6aa9cc');
  img.rect(3, 13, 10, 10, '#e6eaf2'); // cabinet
  img.rect(3, 13, 10, 1, '#ffffff');
  img.rect(11, 14, 1, 9, '#b4bccb');
  img.rect(5, 16, 2, 2, '#4aa3df'); // taps
  img.rect(9, 16, 2, 2, '#e0524d');
  img.rect(6, 20, 4, 2, '#8f98ab');
  outline(img, '#3d4560');
  return { img, ax: 0, ay: 24 };
}

function bin() {
  const img = new Img(T, T);
  img.rect(4, 6, 8, 9, '#5b6178');
  img.rect(4, 6, 8, 1, '#8a91ab');
  img.rect(3, 5, 10, 2, '#7d84a0');
  for (let x = 5; x < 12; x += 2) img.rect(x, 8, 1, 6, '#474c60');
  img.rect(5, 3, 4, 2, '#f4efe6'); // crumpled paper
  outline(img, '#2b2f40');
  return { img, ax: 0, ay: 16 };
}

// ---- step indicator icons (8 x 8, anchor at the bottom centre) ---------------------------------------

const ICON_PAL = {
  o: '#2a2438',
  w: '#ffffff',
  l: '#8fd3f2',
  g: '#5fe3a1',
  y: '#ffd23f',
  p: '#d05bd0',
  r: '#ff6b81',
  b: '#4f86f7',
  k: '#8f98ab',
  n: '#8a6246',
};

function icon(rows) {
  const img = new Img(8, 8);
  img.map(rows, ICON_PAL);
  return { img, ax: 4, ay: 8 };
}

const iconFlask = () =>
  icon(['..oooo..', '...owo..', '...owo..', '..olllo.', '.ollglo.', '.olggglo', '.oggggo.', '..oooo..']);
const iconBrush = () =>
  icon(['......oo', '.....opo', '....opo.', '...onpo.', '..onno..', '.oyyo...', '.oyyo...', '..oo....']);
const iconShield = () =>
  icon(['.oooooo.', 'obbbwbbo', 'obbwwbbo', 'obbwbbbo', 'obbbbbbo', '.obbbbo.', '..obbo..', '...oo...']);
const iconMagnifier = () =>
  icon(['..oooo..', '.owwllo.', 'owllllo.', 'olllllo.', '.ollllo.', '..oooo..', '.....noo', '......nn']);

const PROPS = {
  'icon.flask': iconFlask,
  'icon.brush': iconBrush,
  'icon.shield': iconShield,
  'icon.magnifier': iconMagnifier,
  'prop.desk.2x1': () => desk(false),
  'prop.desk.2x1.lit': () => desk(true),
  'prop.chair': chair,
  'prop.beanbag.1x1.0': () => beanbag(BEAN_COLOURS[0]),
  'prop.beanbag.1x1.1': () => beanbag(BEAN_COLOURS[1]),
  'prop.beanbag.1x1.2': () => beanbag(BEAN_COLOURS[2]),
  'prop.beanbag.1x1.3': () => beanbag(BEAN_COLOURS[3]),
  'prop.coffee.1x1': coffee,
  'prop.whiteboard.4x2': whiteboard,
  'prop.rack.1x2.0': () => rack(0),
  'prop.rack.1x2.1': () => rack(1),
  'prop.window.2x2.0': () => windowArt(0),
  'prop.window.2x2.1': () => windowArt(1),
  'prop.plant.1x1.0': plantRound,
  'prop.plant.1x1.1': plantFern,
  'prop.plant.1x1.2': plantBush,
  'prop.table.8x3': confTable,
  'prop.shelf.2x1': bookcase,
  'prop.fridge.1x1': fridge,
  'prop.cooler.1x1': cooler,
  'prop.bin.1x1': bin,
};

module.exports = { TILES, PROPS, ellipse, outline };
