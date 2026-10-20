// The canvas office: loads the layout (override first), then wires the simulation, renderer, zoom
// toolbar and frame loop together. createOffice(root) returns what mission-control.js drives:
// addAgent(id), setState(id, status), setIndicator(id, iconId|null), removeAgent(id), destroy(). The scene is decorative
// (aria-hidden); the text badge on each agent card remains the accessible status.

import { parseLayout, chooseLayout } from './layout.js';
import { createSim } from './agent.js';
import { createRenderer } from './renderer.js';
import { createLoop } from './loop.js';
import { watchDpr } from './dpr-watch.js';
import { loadAtlas } from './atlas.js';
import { scheduleOnce } from './raf-once.js';
import { seedFromSearch, mulberry32 } from './behaviours.js';
import { nextZoom, maxZoomFor, readZoom, writeZoom, centreFraction, scrollForCentre } from './zoom.js';

const LAYOUT_URL = new URL('../../office/layout.json', import.meta.url);
const OVERRIDE_URL = '/api/office-layout';

async function fetchJson(url, what, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${what} request failed (${res.status})`);
  return res.json();
}

// The optional hand-edited layout (OFFICE_LAYOUT_PATH on the server) is tried first and must pass the same
// validator; any problem is a console warning and the bundled layout is used.
function loadLayout() {
  return chooseLayout({
    fetchOverride: () => fetchJson(OVERRIDE_URL, 'office layout override', { cache: 'no-store' }),
    fetchBundled: () => fetchJson(LAYOUT_URL, 'office layout'),
    parse: parseLayout,
    warn: (reason) => console.warn(`Office layout override not used (bundled layout shown): ${reason}`),
  });
}

function zoomButton(label, text, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `office-zoom-btn${extra}`;
  b.setAttribute('aria-label', label);
  b.textContent = text;
  return b;
}

function showError(root, err) {
  console.error(err);
  const p = document.createElement('p');
  p.className = 'office-error';
  p.textContent = `The office could not be drawn: ${err.message}`;
  root.removeAttribute('aria-hidden'); // this message should be readable
  root.replaceChildren(p);
}

export function createOffice(root) {
  const canvas = document.createElement('canvas');
  canvas.className = 'office-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  root.replaceChildren(canvas);

  // The zoom toolbar is interactive, so it sits before (outside) the aria-hidden office. Hidden until ready.
  const toolbar = document.createElement('div');
  toolbar.className = 'office-zoom';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Office zoom');
  toolbar.hidden = true;
  const zoomOut = zoomButton('Zoom out', '-');
  const zoomReset = zoomButton('Reset zoom to fit', '1x', ' office-zoom-level');
  const zoomIn = zoomButton('Zoom in', '+');
  toolbar.append(zoomOut, zoomReset, zoomIn);
  root.before(toolbar);

  const wanted = new Map(); // id -> status, until the layout is ready
  let live = null; // { sim, renderer, loop, ... } once ready
  let destroyed = false;
  const wantedIcons = new Map(); // id -> icon id, until the layout is ready

  function addAgent(id) {
    if (live) {
      live.syncClock();
      live.sim.addAgent(id);
      live.changed();
    } else if (!wanted.has(id)) wanted.set(id, 'idle');
  }

  function setState(id, status) {
    if (live) {
      live.syncClock();
      live.sim.setStatus(id, status);
      live.changed();
    } else wanted.set(id, status);
  }

  // The step icon shown beside an agent's head (null clears it); a change plays the short transition.
  function setIndicator(id, icon) {
    const next = icon || null;
    if (live) live.setIcon(id, next);
    else if (next) wantedIcons.set(id, next);
    else wantedIcons.delete(id);
  }

  // Idempotent; unknown ids are ignored.
  function removeAgent(id) {
    wantedIcons.delete(id);
    if (live) live.setIcon(id, null, true);
    if (live) {
      live.syncClock();
      live.sim.removeAgent(id);
      live.changed();
    } else wanted.delete(id);
  }

  async function start() {
    let layout;
    let atlas;
    try {
      // the atlas is required: without it the office shows a readable error, never flat colours
      [layout, atlas] = await Promise.all([loadLayout(), loadAtlas()]);
    } catch (err) {
      if (!destroyed) showError(root, err);
      return;
    }
    if (destroyed) return;

    // The flag is cached from the change event: reading `.matches` on every frame can swallow the
    // change notification in Chromium (the read refreshes the cached result first).
    const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = reducedQuery.matches;
    // `?office-seed=<integer>` seeds the simulation (a test hook); otherwise Math.random.
    const seed = seedFromSearch(location.search);
    const sim = createSim({ layout, teleport: reduced, rng: seed === null ? Math.random : mulberry32(seed) });
    const renderer = createRenderer({ canvas, layout, atlas });
    let time = 0;
    const icons = new Map(); // id -> { prev, cur, since }
    let lastInfo = '';
    let lastHeld = null;
    let lastInd = null;

    const loop = createLoop({
      raf: (cb) => requestAnimationFrame(cb),
      caf: (h) => cancelAnimationFrame(h),
      frame(dt) {
        time += dt;
        sim.update(dt);
        renderer.render(sim, time, !reduced, icons);
        publish();
      },
    });

    // Read-only debug/test hook: agent ids with their state, step icons, and the loop mode. No secrets.
    function publish() {
      const all = [...sim.agents.values()];
      const info = all.map((a) => `${a.id}:${a.state}`).join(',');
      const held = all
        .map((a) => [a.id, sim.spots.spotOf(a.id)])
        .filter(([, s]) => s)
        .map(([id, s]) => `${id}:${s.id}`)
        .join(',');
      const ind = [...icons]
        .filter(([, v]) => v.cur)
        .map(([id, v]) => `${id}:${v.cur}`)
        .join(',');
      if (ind !== lastInd) {
        lastInd = ind;
        canvas.dataset.indicators = ind;
      }
      if (info !== lastInfo || held !== lastHeld) {
        lastInfo = info;
        lastHeld = held;
        canvas.dataset.agents = String(sim.agents.size);
        canvas.dataset.states = info;
        canvas.dataset.spots = held;
      }
      canvas.dataset.fits = String(renderer.fits);
      canvas.dataset.loop = loop.state;
      canvas.dataset.atlas = String(atlas.atlas.count);
    }

    // Zoom: a multiplier on the width handed to canvasMetrics. Read once from storage (which may throw).
    let zoom = readZoom(() => window.localStorage);
    let refocus = false; // focus was in the toolbar when the level changed
    let recentre = null; // { fx, fy }: the scene point to keep centred after the next fit
    const dprNow = () => window.devicePixelRatio || 1;

    // The width at which the whole scene fits the box: the smaller of the width-fit (the box width) and
    // the height-fit (when CSS caps the box height with --office-cap, the scene must fit inside it too).
    const fitWidthFor = (width) => {
      const cs = getComputedStyle(root);
      const cap = parseFloat(cs.getPropertyValue('--office-cap')); // NaN when unset (narrow screens)
      if (!Number.isFinite(cap)) return width;
      const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      // one pixel of slack so rounding of the canvas height never adds a scrollbar
      const availH = cap - (Number.isFinite(borders) ? borders : 0) - 1;
      return Math.min(width, (availH * renderer.nativeW) / renderer.nativeH);
    };

    const doFit = () => {
      if (destroyed) return;
      const dpr = dprNow();
      const boxWidth = root.clientWidth;
      // collapsed (display: none) or not laid out: keep the current size and the stored zoom
      if (boxWidth <= 0) return;
      const width = fitWidthFor(boxWidth);
      const max = maxZoomFor(width, dpr, renderer.nativeW, renderer.nativeH);
      if (zoom > max) zoom = max; // e.g. a stored level that is too big for this screen
      const m = renderer.resize(width * zoom, dpr);
      if (recentre) {
        const cw = root.clientWidth;
        const ch = root.clientHeight;
        root.scrollLeft = scrollForCentre(recentre.fx, cw, root.scrollWidth);
        root.scrollTop = scrollForCentre(recentre.fy, ch, root.scrollHeight);
        recentre = null;
      }
      root.classList.toggle('zoomed', zoom > 1);
      zoomReset.textContent = `${zoom}x`;
      zoomOut.disabled = zoom <= 1;
      zoomIn.disabled = nextZoom(zoom, 1) === zoom || nextZoom(zoom, 1) > max;
      // a button that just became disabled would drop keyboard focus: keep it inside the toolbar
      if (refocus) {
        const a = document.activeElement;
        if (!toolbar.contains(a) || a.disabled) zoomReset.focus();
        refocus = false;
      }
      canvas.dataset.zoom = String(zoom);
      canvas.dataset.scale = String(Math.round(m.scale * 1000) / 1000);
      canvas.dataset.fits = String(renderer.fits);
      loop.invalidate();
    };
    // The observer, the window resize event and the pixel-ratio watcher can all fire for one
    // change: they share one fit per animation frame.
    const fitter = scheduleOnce({
      raf: (cb) => requestAnimationFrame(cb),
      caf: (h) => cancelAnimationFrame(h),
      run: doFit,
    });
    const fit = () => fitter.request();

    const setZoom = (z) => {
      if (z === zoom) return;
      zoom = z;
      refocus = toolbar.contains(document.activeElement);
      writeZoom(() => window.localStorage, z);
      recentre = {
        fx: centreFraction(root.scrollLeft, root.clientWidth, root.scrollWidth),
        fy: centreFraction(root.scrollTop, root.clientHeight, root.scrollHeight),
      };
      fit();
    };
    const onZoomClick = (dir) => () => setZoom(nextZoom(zoom, dir));
    const onZoomOut = onZoomClick(-1);
    const onZoomIn = onZoomClick(1);
    const onZoomReset = () => setZoom(1);
    const onZoomKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') zoomIn.disabled || onZoomIn();
      else if (e.key === '-') zoomOut.disabled || onZoomOut();
      else if (e.key === '0') onZoomReset();
      else return;
      e.preventDefault();
    };
    zoomOut.addEventListener('click', onZoomOut);
    zoomIn.addEventListener('click', onZoomIn);
    zoomReset.addEventListener('click', onZoomReset);
    toolbar.addEventListener('keydown', onZoomKey);
    toolbar.hidden = false;

    // Reduced motion has no frame loop, but a celebration must still end: while reduced and
    // visible, one timer wakes the sim for the earliest pending timer (never a setInterval).
    let wakeTimer = null;
    let lastTickAt = performance.now();
    const clearWake = () => {
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      wakeTimer = null;
    };
    // Brings the sim up to date with the wall clock (reduced motion only; the loop does it otherwise).
    const syncClock = () => {
      const now = performance.now();
      if (reduced) {
        if (sim.advance(Math.max(0, (now - lastTickAt) / 1000))) loop.invalidate();
        publish();
      }
      lastTickAt = now;
    };
    const armWake = () => {
      clearWake();
      if (!reduced || document.hidden || destroyed) return;
      const secs = sim.nextWake();
      if (!Number.isFinite(secs)) return;
      wakeTimer = setTimeout(
        () => {
          wakeTimer = null;
          syncClock();
          armWake();
        },
        Math.min(30, Math.max(0.25, secs)) * 1000,
      );
    };
    const changed = () => {
      loop.invalidate();
      armWake();
    };

    const onVisibility = () => {
      loop.setHidden(document.hidden);
      if (!document.hidden) {
        syncClock();
        fit(); // a fit requested while hidden still has to run
      }
      armWake();
      publish();
    };
    const onMotion = (e) => {
      reduced = e.matches;
      lastTickAt = performance.now();
      sim.setTeleport(reduced);
      loop.setContinuous(!reduced);
      loop.invalidate();
      armWake();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(root);
    // A change of device pixel ratio (another monitor, OS scaling) can leave the CSS width as is,
    // and some browsers skip the observer for a window resize: all go through the same fit.
    const stopDpr = watchDpr({
      matchMedia: (q) => matchMedia(q),
      getDpr: dprNow,
      onChange: fit,
    });
    window.addEventListener('resize', fit);
    document.addEventListener('visibilitychange', onVisibility);
    reducedQuery.addEventListener('change', onMotion);

    live = {
      sim,
      loop,
      syncClock,
      changed,
      setIcon(id, icon, drop = false) {
        const e = icons.get(id);
        if (drop) icons.delete(id);
        else if ((e ? e.cur : null) !== icon) {
          if (e) icons.set(id, { prev: e.cur, cur: icon, since: time });
          else if (icon) icons.set(id, { prev: null, cur: icon, since: time });
          else return;
        } else return;
        changed();
        publish();
      },
      stop() {
        fitter.cancel();
        clearWake();
        renderer.destroy();
        ro.disconnect();
        stopDpr();
        window.removeEventListener('resize', fit);
        document.removeEventListener('visibilitychange', onVisibility);
        reducedQuery.removeEventListener('change', onMotion);
        zoomOut.removeEventListener('click', onZoomOut);
        zoomIn.removeEventListener('click', onZoomIn);
        zoomReset.removeEventListener('click', onZoomReset);
        toolbar.removeEventListener('keydown', onZoomKey);
        loop.setHidden(true);
      },
    };
    for (const [id, status] of wanted) sim.setStatus(id, status);
    for (const [id, icon] of wantedIcons) icons.set(id, { prev: null, cur: icon, since: time });
    wantedIcons.clear();
    wanted.clear();
    loop.setContinuous(!reduced);
    loop.setHidden(document.hidden);
    doFit();
    armWake();
  }
  start();

  return {
    addAgent,
    setState,
    setIndicator,
    removeAgent,
    destroy() {
      destroyed = true;
      if (live) live.stop();
      canvas.remove();
      toolbar.remove();
    },
  };
}
