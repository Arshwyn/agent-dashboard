// Constants of the layout JSON format (see "Office layout" in the README). Shared by the validator,
// the grid and the renderer so a new kind or tile character is added in one place.

import { PROP_TYPES } from './sprite-format.js';

export const LAYOUT_VERSION = 1;
export const TILE_SIZE = 16;
export const MAX_DIMENSION = 200; // tiles per side; keeps a typo from allocating a huge grid

export const ZONE_KINDS = ['workspace', 'lounge', 'kitchen', 'meeting', 'server', 'window'];
export const SPOT_KINDS = ['desk', 'beanbag', 'coffee', 'whiteboard', 'server', 'window', 'plant'];
// Prop types are the ones that have sprites (PROP_SPRITES in sprite-format.js).
export { PROP_TYPES };
export const FACINGS = ['up', 'down', 'left', 'right'];

// Tile layers are arrays of `height` strings of `width` characters. Each character names a frame of
// the atlas (public/office/atlas.json).
export const FLOOR_CHARS = {
  '.': 'tile.wood',
  ',': 'tile.carpet',
  ':': 'tile.kitchen',
  '=': 'tile.server',
  g: 'tile.grass',
};
export const WALL_CHARS = '#'; // drawn as tile.wall-top or tile.wall-face (see the renderer)
export const DECOR_CHARS = { r: 'tile.rug' }; // '.' = nothing
export const EMPTY_CHAR = '.';
