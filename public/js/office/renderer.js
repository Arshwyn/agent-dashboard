// Canvas renderer. Draws the tile layers once into an offscreen canvas, then each frame draws props,
// chairs and characters Y-sorted in a single pass. The scale helpers, the sort and the pose choice
// are pure and testable in Node; nothing touches the DOM until createRenderer() is called.
//
// All art comes from the atlas (public/office/atlas.png + atlas.json): tiles, props and the chibi
// character frames. A frame is drawn so that its anchor (ax, ay) lands on a point: the bottom-left
// corner of a prop's footprint, or an agent's foot point.

import { TILE_SIZE as T, FLOOR_CHARS, DECOR_CHARS, WALL_CHARS } from './layout-format.js';
import { lookFor } from './roles.js';
import { propFrameName, charFrameName, indicatorFrameName, CHAIR_FRAME } from './sprite-format.js';
import { iconFrames } from './step-map.js';

export const MAX_SCALE = 8; // device pixels per native pixel
export const MIN_CSS_WIDTH = 640; // the canvas is never shown narrower than this many CSS pixels
export const INTEGER_PREFERENCE = 0.92; // use a whole-number scale when it fills at least this much

// Picks the canvas size for a container width (CSS px) and device pixel ratio. Hybrid rule: with
// fit = containerWidth * dpr / nativeW (device px per native px) and s = floor(fit), a whole-number
// scale s is used when s >= 1, s is at least the minimum-width scale and s / fit >=
// INTEGER_PREFERENCE (crisp, at most 8% unused);
// otherwise the fractional fit is used, clamped to [MIN_CSS_WIDTH * dpr / nativeW, MAX_SCALE].
// The backing store is a whole number of device pixels and is shown at backing / dpr CSS pixels, so
// the browser blits it 1:1. A container narrower than the minimum gets the minimum (the box
// scrolls). Invalid input falls back to the minimum width / a ratio of 1.
export function canvasMetrics(containerWidth, nativeW, nativeH, dpr = 1) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const avail = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 0;
  const minFit = (MIN_CSS_WIDTH * ratio) / nativeW;
  const fit = (avail * ratio) / nativeW;
  const whole = Math.floor(fit);
  let scale;
  let backingWidth;
  if (whole >= 1 && whole >= minFit && whole / fit >= INTEGER_PREFERENCE) {
    scale = Math.min(MAX_SCALE, whole);
    backingWidth = nativeW * scale;
  } else if (fit <= minFit) {
    backingWidth = Math.round(nativeW * minFit);
  } else {
    // floor (with a tiny tolerance for float error) so rounding never overshoots the container
    backingWidth = Math.floor(nativeW * Math.min(fit, MAX_SCALE) + 1e-6);
  }
  const backingHeight = Math.round((backingWidth * nativeH) / nativeW);
  return {
    scale: backingWidth / nativeW,
    backingWidth,
    backingHeight,
    cssWidth: backingWidth / ratio,
    cssHeight: backingHeight / ratio,
  };
}

// Back-to-front draw order: by foot y, ties by id, so the result never depends on input order.
// A drawable is { footY, id, ... }.
export function sortDrawables(list) {
  return [...list].sort((a, b) => a.footY - b.footY || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Foot position of an agent in native pixels (x centre, y a little above the tile bottom).
export function agentFoot(agent) {
  return { x: Math.round((agent.x + 0.5) * T), y: Math.round((agent.y + 1) * T) - 2 };
}

// Which atlas frame an agent shows: { name, mirror }. The state picks the pose, the facing the
// direction (`left` is the `right` frame mirrored when drawn), `time` (seconds) the animation frame.
// With animate=false (reduced motion) every pose holds its first frame. Poses with a single drawn
// direction (typing, alert, celebrate, sit, sleep, drink, stretch, reach, water) ignore the facing,
// so a hand-edited layout with an odd spot facing still finds a frame.
const POSE_FOR_STATE = {
  walking: { pose: 'walk', frames: 4, fps: 8 },
  idle: { pose: 'idle', frames: 2, fps: 2 },
  typing: { pose: 'type', frames: 2, fps: 6, dir: 'up' },
  alert: { pose: 'alert', frames: 2, fps: 3, dir: 'up' },
  celebrate: { pose: 'celebrate', frames: 2, fps: 6, dir: 'down' },
  sit: { pose: 'sit', frames: 1, fps: 1, dir: 'down' },
  sleep: { pose: 'sleep', frames: 2, fps: 1, dir: 'down' },
  drink: { pose: 'drink', frames: 2, fps: 2, dir: 'down' },
  stretch: { pose: 'stretch', frames: 2, fps: 2, dir: 'down' },
  study: { pose: 'reach', frames: 2, fps: 3, dir: 'up' },
  check: { pose: 'reach', frames: 2, fps: 3, dir: 'up' },
  water: { pose: 'water', frames: 2, fps: 3, dir: 'up' },
  look: { pose: 'idle', frames: 2, fps: 2 },
};

// Seated poses are drawn this many native pixels lower so the character sits ON the bean bag.
export const SEAT_DROP = 2;
const SEATED = ['sit', 'sleep'];

export function frameNameFor(agent, time, animate) {
  const entry = Object.hasOwn(POSE_FOR_STATE, agent.state)
    ? POSE_FOR_STATE[agent.state]
    : POSE_FOR_STATE.idle;
  const facing = ['up', 'down', 'left', 'right'].includes(agent.facing) ? agent.facing : 'down';
  const dir = entry.dir || (facing === 'left' ? 'right' : facing);
  const t = Number.isFinite(time) && time > 0 ? time : 0;
  const n = animate ? Math.floor(t * entry.fps) % entry.frames : 0;
  return {
    name: charFrameName(lookFor(agent.id), entry.pose, dir, n),
    mirror: !entry.dir && facing === 'left',
  };
}

// Small canvas drawings that are not atlas frames: the alert bubble, the confetti and the tiny
// activity overlays (steam, water drops, a server LED, chalk marks). Overlays hold their first
// phase when animate is false.
const rect = (ctx, color, x, y, w, h) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};

function drawBubble(ctx, x, y) {
  rect(ctx, '#ffffff', x - 1, y - 1, 10, 12);
  rect(ctx, '#ff6b81', x, y, 8, 10);
  rect(ctx, '#ffffff', x + 3, y + 1, 2, 5);
  rect(ctx, '#ffffff', x + 3, y + 7, 2, 2);
}

function drawConfetti(ctx, foot, time, animate) {
  const phase = animate ? Math.floor(time * 6) % 3 : 0;
  const top = foot.y - 18;
  rect(ctx, '#ffd23f', foot.x - 9, top + phase, 2, 2);
  rect(ctx, '#ff6b81', foot.x + 8, top + 2 - phase, 2, 2);
  rect(ctx, '#5fe3a1', foot.x + 1, top - 5 + phase, 2, 2);
}

const phaseOf = (time, animate, fps, n) => (animate ? Math.floor(Math.max(0, time) * fps) % n : 0);

function drawSteam(ctx, foot, time, animate) {
  const p = phaseOf(time, animate, 2, 2);
  rect(ctx, 'rgba(255,255,255,0.85)', foot.x + 5 + p, foot.y - 17, 1, 2);
  rect(ctx, 'rgba(255,255,255,0.6)', foot.x + 7 - p, foot.y - 20, 1, 2);
}

function drawDrops(ctx, foot, time, animate) {
  const p = phaseOf(time, animate, 4, 3);
  for (let i = 0; i < 2; i++) {
    const y = foot.y - 6 + ((p + i * 2) % 3) * 3;
    rect(ctx, '#8fd3f2', foot.x + 8 + i, y, 1, 2);
  }
}

function drawLed(ctx, foot, time, animate) {
  const on = phaseOf(time, animate, 3, 2) === 0;
  rect(ctx, on ? '#5fe3a1' : '#2b6b52', foot.x + 3, foot.y - 24, 2, 1);
}

function drawChalk(ctx, foot, time, animate) {
  const p = phaseOf(time, animate, 2, 3);
  for (let i = 0; i < 3; i++) {
    if (i <= p) rect(ctx, '#ffffff', foot.x - 4 + i * 4, foot.y - 24 - (i % 2), 2, 1);
  }
}

// Draws atlas frame `name` with its anchor on (x, y), optionally mirrored left-right about the
// anchor. The mirror is an integer translate plus scale(-1, 1), so it stays pixel exact.
function blit(ctx, { atlas, image }, name, x, y, mirror = false) {
  const f = atlas.get(name);
  if (!mirror) {
    ctx.drawImage(image, f.x, f.y, f.w, f.h, x - f.ax, y - f.ay, f.w, f.h);
    return;
  }
  ctx.save();
  ctx.translate(x, y - f.ay);
  ctx.scale(-1, 1);
  ctx.drawImage(image, f.x, f.y, f.w, f.h, -f.ax, 0, f.w, f.h);
  ctx.restore();
}

// True when two metrics give the same backing store and CSS size, so a re-fit has nothing to do.
export function sameMetrics(a, b) {
  return (
    a.backingWidth === b.backingWidth &&
    a.backingHeight === b.backingHeight &&
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight
  );
}

export function createRenderer({ canvas, layout, atlas }) {
  const ctx = canvas.getContext('2d');
  const nativeW = layout.width * T;
  const nativeH = layout.height * T;
  let statics = document.createElement('canvas');
  statics.width = nativeW;
  statics.height = nativeH;
  let sctx = statics.getContext('2d');
  sctx.imageSmoothingEnabled = false;

  // Tile layers: floor, then rug, then walls. A wall tile whose south neighbour is also a wall shows
  // the wall top; otherwise it shows the wall face.
  const isWall = (x, y) => WALL_CHARS.includes(layout.layers.walls[y]?.[x] ?? '.');
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      blit(sctx, atlas, FLOOR_CHARS[layout.layers.floor[y][x]], x * T, y * T);
      const d = layout.layers.decor[y][x];
      if (DECOR_CHARS[d]) blit(sctx, atlas, DECOR_CHARS[d], x * T, y * T);
      if (isWall(x, y))
        blit(sctx, atlas, isWall(x, y + 1) ? 'tile.wall-top' : 'tile.wall-face', x * T, y * T);
    }
  }

  // Props are static drawables. Non-blocking ones (bean bags, windows) sort 3px earlier so a
  // character standing or sitting on their tile is drawn in front. A desk also remembers the desk
  // spots (chairs) in front of it so its monitor lights up while one of them is typing.
  const propItems = layout.props.map((p, i) => ({
    id: `p${String(i).padStart(4, '0')}`,
    footY: (p.y + p.h) * T - (p.blocking ? 0 : 3),
    prop: p,
    seats:
      p.type === 'desk'
        ? layout.spots
            .filter((s) => s.kind === 'desk' && s.y === p.y + p.h && s.x >= p.x && s.x < p.x + p.w)
            .map((s) => s.id)
        : [],
  }));
  const chairItems = layout.spots
    .filter((s) => s.seat && s.kind === 'desk')
    .map((s) => ({ id: `c-${s.id}`, footY: (s.y + 1) * T - 3, chair: s }));

  // The scene is composed at native resolution and scaled once onto the canvas, so a fractional
  // scale cannot leave anti-aliased seams between rectangles.
  let frame = document.createElement('canvas');
  frame.width = nativeW;
  frame.height = nativeH;
  let fctx = frame.getContext('2d');
  fctx.imageSmoothingEnabled = false;

  let metrics = canvasMetrics(nativeW, nativeW, nativeH, 1);
  let destroyed = false;
  let fits = 0; // actual backing-store reallocations (test hook: data-fits)

  // Sizes the canvas for a container width and device pixel ratio; returns the metrics. The backing
  // store is set by attribute; a CSS size is only needed when the ratio is not 1 and is set through
  // CSSOM (not a style attribute), which the CSP allows.
  function resize(containerWidth, dpr) {
    const next = canvasMetrics(containerWidth, nativeW, nativeH, dpr);
    if (
      sameMetrics(next, metrics) &&
      canvas.width === next.backingWidth &&
      canvas.height === next.backingHeight
    )
      return metrics;
    metrics = next;
    fits += 1;
    canvas.width = metrics.backingWidth;
    canvas.height = metrics.backingHeight;
    if (metrics.cssWidth !== metrics.backingWidth) {
      canvas.style.width = `${metrics.cssWidth}px`;
      canvas.style.height = `${metrics.cssHeight}px`;
    } else if (canvas.hasAttribute('style')) canvas.removeAttribute('style');
    return metrics;
  }

  // `indicators`: Map id -> { prev, cur, since } (step icon ids, `since` on the render clock).
  function render(sim, time = 0, animate = true, indicators = null) {
    if (destroyed) return;
    fctx.clearRect(0, 0, nativeW, nativeH);
    fctx.drawImage(statics, 0, 0);
    const litSeats = sim.litSpots();
    const items = [...propItems, ...chairItems];
    for (const a of sim.agents.values()) items.push({ id: `a-${a.id}`, footY: agentFoot(a).y, agent: a });
    for (const it of sortDrawables(items)) {
      if (it.prop) {
        const p = it.prop;
        const lit = it.seats.some((id) => litSeats.has(id));
        blit(fctx, atlas, propFrameName(p, lit), p.x * T, (p.y + p.h) * T);
      } else if (it.chair) blit(fctx, atlas, CHAIR_FRAME, it.chair.x * T, (it.chair.y + 1) * T);
      else {
        const a = it.agent;
        const foot = agentFoot(a);
        const { name, mirror } = frameNameFor(a, time, animate);
        blit(fctx, atlas, name, foot.x, foot.y + (SEATED.includes(a.state) ? SEAT_DROP : 0), mirror);
        if (a.state === 'alert') drawBubble(fctx, foot.x - 4, foot.y - 30);
        if (a.state === 'celebrate') drawConfetti(fctx, foot, time, animate);
        else if (a.state === 'drink') drawSteam(fctx, foot, time, animate);
        else if (a.state === 'water') drawDrops(fctx, foot, time, animate);
        else if (a.state === 'check') drawLed(fctx, foot, time, animate);
        else if (a.state === 'study') drawChalk(fctx, foot, time, animate);
        const ind = indicators && indicators.get(a.id);
        if (ind) {
          // beside the head, clear of the alert bubble; centred on foot.x + 10
          for (const f of iconFrames(ind.prev, ind.cur, time - ind.since, !animate)) {
            fctx.globalAlpha = f.alpha;
            blit(fctx, atlas, indicatorFrameName(f.icon), foot.x + 10, foot.y - 19 + f.dy);
          }
          fctx.globalAlpha = 1;
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, 0, 0, nativeW, nativeH, 0, 0, canvas.width, canvas.height);
  }

  // Releases the offscreen canvases (a canvas keeps its pixel memory until it is shrunk).
  function destroy() {
    for (const c of [statics, frame]) {
      c.width = 0;
      c.height = 0;
    }
    statics = null;
    frame = null;
    sctx = null;
    fctx = null;
    destroyed = true;
  }

  return {
    render,
    resize,
    destroy,
    get fits() {
      return fits;
    },
    nativeW,
    nativeH,
    get metrics() {
      return metrics;
    },
  };
}
