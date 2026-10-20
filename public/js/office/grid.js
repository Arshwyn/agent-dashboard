// Walkable grid and pathfinding. Pure (no DOM), 4-neighbour A* on tile coordinates.

import { WALL_CHARS } from './layout-format.js';

// Builds the grid from a layout: a tile is blocked when it holds a wall character or lies under a
// blocking prop. Out-of-bounds is never walkable.
export function buildGrid(layout) {
  const { width, height } = layout;
  const blocked = new Uint8Array(width * height);
  const rows = layout.layers.walls;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (WALL_CHARS.includes(rows[y][x])) blocked[y * width + x] = 1;
    }
  }
  for (const p of layout.props) {
    if (!p.blocking) continue;
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) blocked[y * width + x] = 1;
      }
    }
  }
  return {
    width,
    height,
    blocked,
    isWalkable: (x, y) => x >= 0 && y >= 0 && x < width && y < height && blocked[y * width + x] === 0,
  };
}

// Binary min-heap on [priority, sequence] so equal priorities pop in insertion order (deterministic).
class Heap {
  constructor() {
    this.a = [];
    this.seq = 0;
  }
  get size() {
    return this.a.length;
  }
  less(i, j) {
    const p = this.a[i];
    const q = this.a[j];
    return p.f < q.f || (p.f === q.f && p.n < q.n);
  }
  push(node, f) {
    this.a.push({ node, f, n: this.seq++ });
    let i = this.a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      [this.a[i], this.a[parent]] = [this.a[parent], this.a[i]];
      i = parent;
    }
  }
  pop() {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.less(l, m)) m = l;
        if (r < this.a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [this.a[i], this.a[m]] = [this.a[m], this.a[i]];
        i = m;
      }
    }
    return top.node;
  }
}

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

// Shortest 4-neighbour path from `from` to `to` as [{x,y}, ...] including both ends, or null when
// either end is not walkable or no route exists. from == to gives a one-tile path.
export function findPath(grid, from, to) {
  if (!grid.isWalkable(from.x, from.y) || !grid.isWalkable(to.x, to.y)) return null;
  const w = grid.width;
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  if (start === goal) return [{ x: from.x, y: from.y }];
  const g = new Map([[start, 0]]);
  const prev = new Map();
  const closed = new Set();
  const h = (i) => Math.abs((i % w) - to.x) + Math.abs(Math.floor(i / w) - to.y);
  const open = new Heap();
  open.push(start, h(start));
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) {
      const out = [];
      for (let i = goal; i !== undefined; i = prev.get(i)) out.push({ x: i % w, y: Math.floor(i / w) });
      return out.reverse();
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!grid.isWalkable(nx, ny)) continue;
      const ni = ny * w + nx;
      if (closed.has(ni)) continue;
      const ng = g.get(cur) + 1;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        prev.set(ni, cur);
        open.push(ni, ng + h(ni));
      }
    }
  }
  return null;
}

// Set of tile indexes (y * width + x) reachable from `from` (empty when `from` is not walkable).
export function reachableFrom(grid, from) {
  const seen = new Set();
  if (!grid.isWalkable(from.x, from.y)) return seen;
  const w = grid.width;
  const stack = [from.y * w + from.x];
  seen.add(stack[0]);
  while (stack.length) {
    const cur = stack.pop();
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!grid.isWalkable(nx, ny)) continue;
      const ni = ny * w + nx;
      if (!seen.has(ni)) {
        seen.add(ni);
        stack.push(ni);
      }
    }
  }
  return seen;
}
