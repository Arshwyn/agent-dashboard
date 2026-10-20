// Agent card portraits: a 16x16 canvas that shows the role's own portrait frame from the office
// atlas (the same art as the scene). CSS scales it up with pixelated rendering. If the atlas fails
// to load the canvas stays blank; the card text is unaffected.

import { loadAtlas } from './office/atlas.js';
import { lookFor } from './office/roles.js';
import {
  portraitFrameName,
  indicatorFrameName,
  PORTRAIT_SIZE,
  INDICATOR_SIZE,
} from './office/sprite-format.js';

export function createAvatar(id) {
  const canvas = document.createElement('canvas');
  canvas.className = 'avatar';
  canvas.width = PORTRAIT_SIZE;
  canvas.height = PORTRAIT_SIZE;
  canvas.setAttribute('aria-hidden', 'true');
  loadAtlas()
    .then(({ atlas, image }) => {
      const f = atlas.get(portraitFrameName(lookFor(id)));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, f.x, f.y, f.w, f.h, 0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
      canvas.dataset.look = lookFor(id);
    })
    .catch(() => {});
  return canvas;
}

// A small step icon (flask, brush, shield, magnifier) from the same atlas, for the agent card. Blank
// if the atlas fails to load; the text label next to it carries the meaning.
export function createIcon(id) {
  const canvas = document.createElement('canvas');
  canvas.className = 'step-icon';
  canvas.width = INDICATOR_SIZE;
  canvas.height = INDICATOR_SIZE;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.icon = id;
  loadAtlas()
    .then(({ atlas, image }) => {
      const f = atlas.get(indicatorFrameName(id));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, f.x, f.y, f.w, f.h, 0, 0, INDICATOR_SIZE, INDICATOR_SIZE);
    })
    .catch(() => {});
  return canvas;
}
