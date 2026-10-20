// The sprite atlas: parseAtlas validates atlas.json (pure, testable in Node) and loadAtlas fetches
// atlas.json and atlas.png (browser). The office renderer and the card portraits share one load.

import {
  ATLAS_VERSION,
  TILE_NAMES,
  ROLES,
  FALLBACK_LOOK,
  PERSON_LOOKS,
  INDICATOR_IDS,
  indicatorFrameName,
  propFrameNames,
  lookFrameNames,
} from './sprite-format.js';

const JSON_URL = new URL('../../office/atlas.json', import.meta.url);
const PNG_URL = new URL('../../office/atlas.png', import.meta.url);

export class AtlasError extends Error {
  constructor(errors) {
    super(`Invalid office atlas: ${errors.join('; ')}`);
    this.name = 'AtlasError';
    this.errors = errors;
  }
}

// Every frame name the app relies on: tiles, props (with variants), the chair the step icons and all eight looks.
export function requiredFrameNames() {
  return [
    ...TILE_NAMES,
    ...propFrameNames(),
    ...INDICATOR_IDS.map(indicatorFrameName),
    ...[...ROLES, FALLBACK_LOOK, ...PERSON_LOOKS].flatMap((look) => lookFrameNames(look)),
  ];
}

const isInt = (n) => Number.isInteger(n);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// Returns the list of problems (empty when valid). Never throws on bad input.
export function validateAtlas(json) {
  const errors = [];
  if (!isObj(json)) return ['atlas must be a JSON object'];
  if (json.version !== ATLAS_VERSION) {
    return [`unsupported version ${JSON.stringify(json.version)} (expected ${ATLAS_VERSION})`];
  }
  const { width, height } = json;
  if (!isInt(width) || !isInt(height) || width < 1 || height < 1) {
    return ['width and height must be positive integers'];
  }
  if (!isObj(json.frames)) return ['frames must be an object'];
  const known = new Set(requiredFrameNames());
  const rects = [];
  for (const [name, f] of Object.entries(json.frames)) {
    if (!known.has(name)) {
      errors.push(`unknown frame '${name}'`);
      continue;
    }
    if (!isObj(f) || ![f.x, f.y, f.w, f.h, f.ax, f.ay].every(isInt)) {
      errors.push(`frame '${name}' needs integer x, y, w, h, ax, ay`);
      continue;
    }
    if (f.w < 1 || f.h < 1 || f.x < 0 || f.y < 0 || f.x + f.w > width || f.y + f.h > height) {
      errors.push(`frame '${name}' is out of the ${width}x${height} image bounds`);
      continue;
    }
    if (f.ax < 0 || f.ax > f.w || f.ay < 0 || f.ay > f.h) {
      errors.push(`frame '${name}' has its anchor outside the frame`);
      continue;
    }
    rects.push([name, f]);
  }
  for (const name of known) {
    if (!Object.hasOwn(json.frames, name)) errors.push(`missing frame '${name}'`);
  }
  // two names must not share pixels (a copy-paste slip that would draw the wrong sprite)
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [an, a] = rects[i];
      const [bn, b] = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        errors.push(`frames '${an}' and '${bn}' overlap`);
      }
    }
  }
  return errors;
}

// Validates and returns { width, height, frames, has(name), get(name), count }; throws AtlasError.
export function parseAtlas(json) {
  const errors = validateAtlas(json);
  if (errors.length) throw new AtlasError(errors);
  const frames = json.frames;
  return {
    width: json.width,
    height: json.height,
    frames,
    count: Object.keys(frames).length,
    has: (name) => Object.hasOwn(frames, name),
    get(name) {
      if (!Object.hasOwn(frames, name)) throw new Error(`atlas has no frame '${name}'`);
      return frames[name];
    },
  };
}

let loading = null;

// Fetches atlas.json and atlas.png once (memoised) and resolves { atlas, image }. A failed load is
// not remembered, so the next call tries again.
export function loadAtlas() {
  if (!loading) {
    loading = (async () => {
      const res = await fetch(JSON_URL);
      if (!res.ok) throw new Error(`office atlas request failed (${res.status})`);
      const atlas = parseAtlas(await res.json());
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('office atlas image could not be loaded'));
        img.src = PNG_URL.href;
      });
      if (image.naturalWidth !== atlas.width || image.naturalHeight !== atlas.height) {
        throw new Error(
          `office atlas image is ${image.naturalWidth}x${image.naturalHeight}, atlas.json says ${atlas.width}x${atlas.height}`,
        );
      }
      return { atlas, image };
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
