// Watches for device pixel ratio changes (dragging the window to another monitor, OS display
// scaling) that leave the CSS width unchanged and so do not trigger a ResizeObserver. A
// `(resolution: Ndppx)` media query only fires once, when the ratio leaves N, so it is re-armed with
// the new ratio after every change. Pure apart from the injected functions, so it is unit-tested.

export function watchDpr({ matchMedia, getDpr, onChange }) {
  let query = null;
  let handler = null;
  let stopped = false;

  function disarm() {
    if (query && handler) query.removeEventListener('change', handler);
    query = null;
    handler = null;
  }

  function arm() {
    disarm();
    if (stopped) return;
    query = matchMedia(`(resolution: ${getDpr()}dppx)`);
    handler = () => {
      arm();
      onChange();
    };
    query.addEventListener('change', handler);
  }

  arm();
  return () => {
    stopped = true;
    disarm();
  };
}
