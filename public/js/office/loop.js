// Frame scheduling. One requestAnimationFrame at a time, never while the tab is hidden, and never
// continuously under reduced motion (then a frame is drawn only on invalidate()). The environment
// is injected so the logic runs under `node --test`.

export const MAX_DT = 0.1; // seconds; a long stall (slow tab, debugger) must not teleport agents

export function createLoop({ frame, raf, caf, maxDt = MAX_DT }) {
  let continuous = true;
  let hidden = false;
  let handle = null;
  let last = null;
  let dirty = true;

  function onFrame(ts) {
    handle = null;
    const dt = last === null ? 0 : Math.min(maxDt, Math.max(0, (ts - last) / 1000));
    last = ts;
    dirty = false;
    frame(dt);
    if (continuous && !hidden) schedule();
  }

  function schedule() {
    if (handle === null && !hidden) handle = raf(onFrame);
  }

  function cancel() {
    if (handle !== null) caf(handle);
    handle = null;
  }

  return {
    // Draw (at least) one more frame. Cheap to call repeatedly.
    invalidate() {
      dirty = true;
      schedule();
    },
    setHidden(h) {
      hidden = Boolean(h);
      last = null; // the next frame has dt 0: no jump after a pause
      if (hidden) cancel();
      else if (continuous || dirty) schedule();
    },
    setContinuous(c) {
      continuous = Boolean(c);
      last = null;
      if (continuous) schedule();
      else if (!dirty) cancel();
    },
    get state() {
      if (hidden) return 'paused';
      return continuous ? 'running' : 'static';
    },
    get scheduled() {
      return handle !== null;
    },
  };
}
