// Runs `run` at most once per animation frame, however many times request() is called. Used to
// coalesce the resize observer, the window resize event and the pixel-ratio watcher into one fit.
// The environment is injected so the logic runs under `node --test`.

export function scheduleOnce({ raf, caf, run }) {
  let handle = null;
  return {
    request() {
      if (handle !== null) return;
      handle = raf(() => {
        handle = null;
        run();
      });
    },
    cancel() {
      if (handle !== null) caf(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}
