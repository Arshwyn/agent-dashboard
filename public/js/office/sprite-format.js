// Names and tables of the office atlas (public/office/atlas.png + atlas.json). Pure ESM: the
// renderer, the portraits, the tests and the generator (scripts/build-office-atlas.js, through a
// dynamic import) all read the same table, so a frame is never named in two places.

export const ATLAS_VERSION = 1;

// The seven roles (one fixed look each) and the id of the look used for any other agent.
export const ROLES = ['spec', 'code', 'cleanup', 'server-ops', 'ask', 'verify', 'review'];
export const FALLBACK_LOOK = 'fallback';

// ---- tiles ----------------------------------------------------------------------------------------

export const TILE_NAMES = [
  'tile.wood',
  'tile.carpet',
  'tile.kitchen',
  'tile.server',
  'tile.grass',
  'tile.rug',
  'tile.wall-top',
  'tile.wall-face',
];

// ---- props ----------------------------------------------------------------------------------------
// Frame name: prop.<type>.<w>x<h>[.<variant>]. For every type and footprint the layout may use:
//   lit      a second frame ".lit" is drawn while the prop is in use (a desk whose holder is typing);
//   variants n frames ".0" .. ".n-1", picked by (x + y) % n so neighbours differ and a prop never
//            changes look between frames.
export const PROP_SPRITES = {
  desk: { '2x1': { lit: true } },
  beanbag: { '1x1': { variants: 4 } },
  coffee: { '1x1': {} },
  counter: { '11x1': {} },
  whiteboard: { '4x2': {} },
  rack: { '1x2': { variants: 2 } },
  window: { '2x2': { variants: 2 } },
  plant: { '1x1': { variants: 3 } },
  table: { '3x2': {}, '4x2': {}, '8x3': {} },
  shelf: { '2x1': {} },
  fridge: { '1x1': {} },
  cooler: { '1x1': {} },
  bin: { '1x1': {} },
  frame: { '1x1': { variants: 3 } },
};
export const PROP_TYPES = Object.keys(PROP_SPRITES);
export const CHAIR_FRAME = 'prop.chair';

// Frame name for a layout prop. Returns null when the (type, w, h) has no sprite.
export function propFrameName(prop, lit = false) {
  const spec = Object.hasOwn(PROP_SPRITES, prop.type)
    ? PROP_SPRITES[prop.type][`${prop.w}x${prop.h}`]
    : undefined;
  if (!spec) return null;
  const base = `prop.${prop.type}.${prop.w}x${prop.h}`;
  if (spec.variants) return `${base}.${(prop.x + prop.y) % spec.variants}`;
  return spec.lit && lit ? `${base}.lit` : base;
}

// Every prop frame name the table implies, in a stable order.
export function propFrameNames() {
  const names = [];
  for (const [type, sizes] of Object.entries(PROP_SPRITES)) {
    for (const [size, spec] of Object.entries(sizes)) {
      const base = `prop.${type}.${size}`;
      if (spec.variants) for (let i = 0; i < spec.variants; i++) names.push(`${base}.${i}`);
      else {
        names.push(base);
        if (spec.lit) names.push(`${base}.lit`);
      }
    }
  }
  return [CHAIR_FRAME, ...names];
}

// ---- step indicator icons -------------------------------------------------------------------------
// Small 8x8 icons drawn beside the head of a merged agent (verify, review) while it works. Frame
// name icon.<id>; the anchor is the bottom centre. step-map.js maps pipeline steps to these ids.
export const INDICATOR_IDS = ['flask', 'brush', 'shield', 'magnifier'];
export const INDICATOR_SIZE = 8;
export const indicatorFrameName = (id) => `icon.${id}`;

// ---- characters -----------------------------------------------------------------------------------

export const CHAR_W = 16;
export const CHAR_H = 20;
export const CHAR_AX = 8; // horizontal centre of the sprite
export const CHAR_AY = 18; // foot point: two pixels above the bottom of the cell
export const PORTRAIT_SIZE = 16;
export const DIRS = ['down', 'up', 'right']; // `left` is `right` mirrored when drawn

// pose -> { dirs, frames }. Every pose is wired to an agent state (see POSE_FOR_STATE in renderer.js).
export const POSES = {
  walk: { dirs: ['down', 'up', 'right'], frames: 4 },
  idle: { dirs: ['down', 'up', 'right'], frames: 2 },
  type: { dirs: ['up'], frames: 2 },
  alert: { dirs: ['up'], frames: 2 },
  celebrate: { dirs: ['down'], frames: 2 },
  sit: { dirs: ['down'], frames: 1 },
  sleep: { dirs: ['down'], frames: 2 },
  drink: { dirs: ['down'], frames: 2 },
  stretch: { dirs: ['down'], frames: 2 },
  reach: { dirs: ['up'], frames: 2 },
  water: { dirs: ['up'], frames: 2 },
};

export const charFrameName = (look, pose, dir, n) => `char.${look}.${pose}.${dir}.${n}`;
export const portraitFrameName = (look) => `char.${look}.portrait`;

// All frame names of one look (35 pose frames plus the portrait), in a stable order.
export function lookFrameNames(look) {
  const names = [];
  for (const [pose, { dirs, frames }] of Object.entries(POSES)) {
    for (const dir of dirs) for (let n = 0; n < frames; n++) names.push(charFrameName(look, pose, dir, n));
  }
  names.push(portraitFrameName(look));
  return names;
}
