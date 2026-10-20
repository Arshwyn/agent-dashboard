// Zoom for the canvas office: pure helpers (no DOM) plus the storage key. A zoom level z multiplies the
// container width passed to canvasMetrics, so z = 1 is today's fit-to-width and z > 1 makes the canvas
// wider than its box (the box scrolls inside itself).

import { canvasMetrics } from './renderer.js';

export const ZOOM_LEVELS = Object.freeze([1, 2, 3, 4]);
export const ZOOM_KEY = 'office.zoom';
export const MAX_BACKING_WIDTH = 8192; // device pixels; bounds the canvas memory

// The next level in direction dir (+1 / -1), clamped to the levels; an unknown z snaps to 1 first.
export function nextZoom(z, dir) {
  const i = ZOOM_LEVELS.indexOf(z);
  const at = i < 0 ? 0 : i;
  const step = dir > 0 ? 1 : dir < 0 ? -1 : 0;
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, at + step))];
}

// A stored value is only trusted when it is exactly one of the level strings ("2"), nothing else.
export function parseStoredZoom(raw) {
  if (typeof raw !== 'string') return 1;
  const z = ZOOM_LEVELS.find((l) => String(l) === raw);
  return z ?? 1;
}

// The highest level worth offering: its backing width (from canvasMetrics) stays within MAX_BACKING_WIDTH
// and is bigger than the previous level's (the renderer caps the scale, so a level past the cap would only
// repeat the picture). At least 1.
export function maxZoomFor(containerWidth, dpr, nativeW, nativeH) {
  let best = ZOOM_LEVELS[0];
  let prev = canvasMetrics(containerWidth * best, nativeW, nativeH, dpr).backingWidth;
  for (const z of ZOOM_LEVELS.slice(1)) {
    const w = canvasMetrics(containerWidth * z, nativeW, nativeH, dpr).backingWidth;
    if (w > MAX_BACKING_WIDTH || w <= prev) break;
    best = z;
    prev = w;
  }
  return best;
}

// Where the viewport centre sits in the content, as a fraction (0.5 when the content fits).
export function centreFraction(scroll, viewport, content) {
  if (!(content > viewport) || !(content > 0)) return 0.5;
  return Math.min(1, Math.max(0, (scroll + viewport / 2) / content));
}

// The scroll offset that puts content fraction f at the viewport centre, clamped to the scroll range.
export function scrollForCentre(f, viewport, content) {
  const max = Math.max(0, content - viewport);
  return Math.min(max, Math.max(0, f * content - viewport / 2));
}

// Reads/writes the stored level. getStorage is a function because even touching window.localStorage can
// throw (blocked site data); any failure is ignored.
export function readZoom(getStorage) {
  try {
    return parseStoredZoom(getStorage().getItem(ZOOM_KEY));
  } catch {
    return 1;
  }
}

export function writeZoom(getStorage, z) {
  try {
    getStorage().setItem(ZOOM_KEY, String(z));
  } catch {
    // not persisted; the office keeps working
  }
}
