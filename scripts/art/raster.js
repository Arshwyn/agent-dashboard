'use strict';

// Tiny RGBA raster used by the art scripts. Pixels are [r, g, b, a] arrays or null (transparent).

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(255);
const toColour = (c) => (c === null || c === undefined ? null : typeof c === 'string' ? hex(c) : c);

class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Array(w * h).fill(null);
  }

  set(x, y, c) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = toColour(c);
  }

  get(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[y * this.w + x] : null;
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  // Draws `other` on top of this image at (ox, oy); transparent pixels are skipped, translucent
  // pixels are blended over what is there.
  blit(other, ox = 0, oy = 0) {
    for (let y = 0; y < other.h; y++) {
      for (let x = 0; x < other.w; x++) {
        const p = other.px[y * other.w + x];
        if (!p) continue;
        const q = this.get(ox + x, oy + y);
        if (p[3] === 255 || !q) this.set(ox + x, oy + y, p);
        else {
          const a = p[3] / 255;
          const mix = (i) => Math.round(p[i] * a + q[i] * (1 - a));
          this.set(ox + x, oy + y, [mix(0), mix(1), mix(2), Math.max(p[3], q[3])]);
        }
      }
    }
    return this;
  }

  // Paints a string map: each character looks up its colour in `palette`; '.' and ' ' (and any
  // character without a palette entry) leave the pixel alone.
  map(rows, palette, ox = 0, oy = 0) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = palette[row[x]];
        if (c && row[x] !== '.') this.set(ox + x, oy + y, c);
      }
    });
    return this;
  }

  crop(x, y, w, h) {
    const out = new Img(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.px[j * w + i] = this.get(x + i, y + j);
    return out;
  }

  count() {
    return this.px.filter(Boolean).length;
  }

  toRgba() {
    const buf = Buffer.alloc(this.w * this.h * 4);
    this.px.forEach((p, i) => p && buf.set(p, i * 4));
    return buf;
  }

  static fromRgba(w, h, buf) {
    const img = new Img(w, h);
    for (let i = 0; i < w * h; i++) {
      const a = buf[i * 4 + 3];
      img.px[i] = a === 0 ? null : [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], a];
    }
    return img;
  }
}

// Shade helpers for deriving a three-tone ramp from one base colour (deterministic integer maths).
const shade = (c, pct) => {
  const [r, g, b] = toColour(c);
  const f = (v) =>
    Math.max(0, Math.min(255, Math.round(pct >= 0 ? v + ((255 - v) * pct) / 100 : (v * (100 + pct)) / 100)));
  return [f(r), f(g), f(b), 255];
};

module.exports = { Img, hex, toColour, shade };
