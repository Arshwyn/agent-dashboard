'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect, login } = require('./fixtures');

const ROLES = ['spec', 'code', 'cleanup', 'server-ops', 'ask', 'verify', 'review'];
const SHOTS = path.join(__dirname, '..', 'e2e-artifacts');
fs.mkdirSync(SHOTS, { recursive: true });

const card = (page, id) => page.getByRole('article', { name: `Agent ${id}`, exact: true });
const feed = (page) => page.locator('#feed li');
const toggle = (page, id) => page.locator(`button.sec-toggle[data-section="${id}"]`);
// Costs and sessions are collapsed by default: open one (no-op when already open).
async function openSection(page, id) {
  if ((await toggle(page, id).getAttribute('aria-expanded')) !== 'true') await toggle(page, id).click();
  await expect(toggle(page, id)).toHaveAttribute('aria-expanded', 'true');
}

test.describe.configure({ mode: 'serial' });

test.describe('authentication', () => {
  test('unauthenticated visit redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Mission Control' })).toBeVisible();
    await expect(page.locator('#agents')).toHaveCount(0);
  });

  test('wrong token is rejected, correct token logs in', async ({ page, server, problems }) => {
    await page.goto('/login');
    await page.getByLabel('Dashboard token').fill('definitely-not-the-right-value-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid token.');
    // The browser logs the deliberate 401 response; that one console line is expected here.
    expect(problems.splice(0)).toEqual([expect.stringContaining('status of 401')]);
    await expect(page.locator('#agents')).toHaveCount(0);

    await page.getByLabel('Dashboard token').fill(server.dashboardToken);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#conn')).toContainText('live');
  });
});

test.describe('dashboard', () => {
  test('renders one card per role with a text status badge and live connection', async ({
    authedPage: page,
  }) => {
    await expect(page.locator('#agents article.card')).toHaveCount(ROLES.length);
    for (const role of ROLES) {
      const c = card(page, role);
      await expect(c).toBeVisible();
      await expect(c.locator('.badge')).toHaveText(/IDLE/);
    }
    await expect(page.locator('#conn')).toHaveClass(/conn-live/);
    await expect(page.locator('#feed-empty')).toBeVisible();
    await expect(page.locator('#pipeline')).toContainText('No pipeline run yet.');
  });

  test('empty states: title plus one line, no dashed fake table', async ({ authedPage: page }) => {
    await expect(page.locator('#feed-empty h3')).toContainText(
      'No events yet. Waiting for agents to report in.',
    );
    await expect(page.locator('#pipeline h3')).toContainText('No pipeline run yet.');
    await expect(page.locator('#activity h3')).toHaveText('No other requests yet.');
    await openSection(page, 'sessions');
    await expect(page.locator('#sessions-summary h3')).toContainText('No sessions with token usage yet.');
    await expect(page.locator('#sessions-summary .empty-line')).toBeVisible();
    for (const el of await page.locator('.empty').all()) {
      if (await el.isVisible())
        expect(await el.evaluate((e) => getComputedStyle(e).borderStyle)).not.toBe('dashed');
    }
    // cost data unavailable -> the cost empty state
    await page.route('**/api/costs*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await page.reload();
    await expect(page.locator('#costs-summary h3')).toContainText('No cost data yet.');
    await expect(page.locator('#costs-summary .empty-line')).toContainText('token usage');
    await page.unroute('**/api/costs*');
    await toggle(page, 'sessions').click();
  });

  test('ingested events update cards, feed and filter', async ({ authedPage: page, server }) => {
    await server.emit({ agent: 'code', type: 'status', task: 'Build the widget', summary: 'starting' });
    await server.emit({
      agent: 'code',
      type: 'tool_start',
      tool: 'Bash',
      summary: 'Bash: npm test',
      task: 'Build the widget',
    });
    await server.emit({
      agent: 'review',
      type: 'notification',
      summary: 'needs permission',
      task: 'Audit diff',
    });
    await server.emit({
      agent: 'verify',
      type: 'subagent_stop',
      summary: 'finished',
      tokens_in: 1500,
      tokens_out: 300,
    });

    const code = card(page, 'code');
    await expect(code.locator('.badge')).toHaveText(/WORKING/);
    await expect(code.locator('.task')).toHaveText('Build the widget');
    await expect(card(page, 'review').locator('.badge')).toHaveText(/BLOCKED/);
    await expect(card(page, 'verify').locator('.badge')).toHaveText(/DONE/);
    await expect(card(page, 'verify')).toContainText('1.5k');

    await expect(page.locator('#feed-empty')).toBeHidden();
    await expect(feed(page).first()).toContainText('verify');
    await expect(page.locator('#feed')).toContainText('tool_start:Bash');
    await expect(page.locator('#feed')).toContainText('Bash: npm test');

    // A new event arrives live without a reload and lands at the top.
    await server.emit({ agent: 'spec', type: 'tool_start', tool: 'Edit', summary: 'Edit: app.css' });
    await expect(feed(page).first()).toContainText('Edit: app.css');
    await expect(card(page, 'spec').locator('.badge')).toHaveText(/WORKING/);

    // Filter by agent.
    await page.locator('#feed-filter').selectOption('review');
    await expect(feed(page)).toHaveCount(1);
    await expect(feed(page).first()).toContainText('review');
    await page.locator('#feed-filter').selectOption('');
    await expect(feed(page).nth(3)).toBeVisible();
  });

  test('desktop screenshot', async ({ authedPage: page }) => {
    await expect(card(page, 'code').locator('.badge')).toHaveText(/WORKING/);
    await page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
  });
});

// States an idle agent can show: walking to somewhere, standing, or one of the spot activities.
const ACTIVITY = ['sit', 'sleep', 'drink', 'study', 'check', 'look', 'water', 'stretch'];
const IDLE_OR_WALKING = new RegExp(`^(idle|walking|${ACTIVITY.join('|')})$`);

// Runs before any pipeline event reaches the shared per-worker server.
test('the header run summary reads No active run when no run exists', async ({ authedPage: page }) => {
  await expect(page.locator('#run-summary')).toHaveText('No active run');
});

test.describe('canvas office', () => {
  const canvas = (page) => page.locator('#office canvas.office-canvas');
  // data-states is "id:state,id:state" (read-only hook with agent ids and states only).
  const stateOf = async (page, id) => {
    const raw = (await canvas(page).getAttribute('data-states')) || '';
    const hit = raw.split(',').find((e) => e.startsWith(`${id}:`));
    return hit ? hit.slice(id.length + 1) : null;
  };
  const expectState = (page, id, re, timeout = 7_000) =>
    expect.poll(() => stateOf(page, id), { timeout }).toMatch(re);
  const distinctColours = (page) =>
    canvas(page).evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      let transparent = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        if (d[i + 3] === 0) transparent++;
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return { colours: seen.size, transparent };
    });

  test('draws a decorative, crisp canvas with a character for every agent', async ({
    authedPage: page,
    server,
  }) => {
    await expect(page.locator('#office')).toHaveAttribute('aria-hidden', 'true');
    await expect(canvas(page)).toHaveCount(1);
    await expect(canvas(page)).toHaveAttribute('aria-hidden', 'true');
    // 64x40 tiles of 16px. The box is capped at 420px tall, so the default fit is the smaller of the
    // width-fit and the height-fit: the whole scene is visible (1280px viewport, device pixel ratio 1).
    const box = await page.locator('#office').evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }));
    const w = Number(await canvas(page).getAttribute('width'));
    const ch = Number(await canvas(page).getAttribute('height'));
    expect(w).toBeLessThanOrEqual(box.w);
    expect(ch).toBeLessThanOrEqual(box.h);
    expect(ch).toBeLessThanOrEqual(414);
    expect(ch).toBe(Math.round((w * 640) / 1024));
    expect(Number(await canvas(page).getAttribute('data-scale'))).toBeGreaterThan(0.5);
    await expect.poll(() => canvas(page).getAttribute('data-agents')).toBe(String(ROLES.length));
    // the atlas is loaded and drawn: a positive frame count and far more colours than flat tiles
    await expect.poll(async () => Number(await canvas(page).getAttribute('data-atlas'))).toBeGreaterThan(300);
    const px = await distinctColours(page);
    expect(px.colours).toBeGreaterThan(40);
    expect(px.transparent).toBe(0);
    // Cards keep their text status and show a canvas portrait from the same atlas; the scene has no
    // text or roles of its own.
    for (const role of ROLES) await expect(card(page, role).locator('canvas.avatar')).toHaveCount(1);
    const portraits = {};
    for (const role of ['spec', 'ask', 'code']) {
      portraits[role] = await card(page, role)
        .locator('canvas.avatar')
        .evaluate((c) => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
          return {
            w: c.width,
            h: c.height,
            aria: c.getAttribute('aria-hidden'),
            opaque,
            sig: Array.from(d).join(','),
          };
        });
      expect(portraits[role].w).toBe(16);
      expect(portraits[role].h).toBe(16);
      expect(portraits[role].aria).toBe('true');
      expect(portraits[role].opaque).toBeGreaterThan(40);
    }
    expect(portraits.spec.sig).not.toBe(portraits.ask.sig);
    expect(portraits.code.sig).not.toBe(portraits.ask.sig);
    expect(await page.locator('#office').innerText()).toBe('');
    // No style attributes anywhere (the CSP forbids them) and no leftover DOM office.
    await expect(page.locator('[style]')).toHaveCount(0);
    await expect(page.locator('#office .char, #office .desk')).toHaveCount(0);

    // An agent id that is not a role gets the fallback look and its own character.
    await server.emit({ agent: 'orchestrator', type: 'status', task: 'route', summary: 'hi' });
    await expect.poll(() => canvas(page).getAttribute('data-agents')).toBe(String(ROLES.length + 1));
    // `problems` (auto fixture) fails the test on any console error or CSP violation.
  });

  test('status drives the characters: idle, walk to the desk and type, alert, celebrate, idle', async ({
    authedPage: page,
    server,
  }) => {
    test.setTimeout(90_000);
    await expectState(page, 'ask', IDLE_OR_WALKING);
    await server.emit({ agent: 'ask', type: 'tool_start', tool: 'Read', summary: 'Read: x', task: 'Answer' });
    await expect(card(page, 'ask').locator('.badge')).toHaveText(/WORKING/);
    await expectState(page, 'ask', /^walking$/);
    await expectState(page, 'ask', /^typing$/, 45_000);
    const before = await distinctColours(page);
    expect(before.colours).toBeGreaterThan(40);

    await server.emit({ agent: 'ask', type: 'notification', summary: 'needs permission' });
    await expect(card(page, 'ask').locator('.badge')).toHaveText(/BLOCKED/);
    await expectState(page, 'ask', /^alert$/);

    await server.emit({ agent: 'ask', type: 'subagent_stop', summary: 'finished' });
    await expect(card(page, 'ask').locator('.badge')).toHaveText(/DONE/);
    await expectState(page, 'ask', /^celebrate$/);
    await page.screenshot({ path: path.join(SHOTS, 'office.png'), fullPage: true });
    // after the celebration the character goes back to idle behaviour
    await expectState(page, 'ask', IDLE_OR_WALKING, 15_000);
  });

  test('with prefers-reduced-motion characters jump to their place and no loop runs', async ({
    authedPage: page,
    server,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(canvas(page)).toHaveAttribute('data-loop', 'static');
    await server.emit({ agent: 'cleanup', type: 'tool_start', tool: 'Bash', summary: 'Bash: ls', task: 'x' });
    await expect(card(page, 'cleanup').locator('.badge')).toHaveText(/WORKING/);
    // never passes through the walking state
    await expectState(page, 'cleanup', /^typing$/);
    const states = [];
    for (let i = 0; i < 5; i++) {
      states.push(await stateOf(page, 'cleanup'));
      await page.waitForTimeout(100);
    }
    expect(states.every((st) => st === 'typing')).toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(canvas(page)).toHaveAttribute('data-loop', 'running');
  });

  test('rendering pauses while the tab is hidden and resumes afterwards', async ({ authedPage: page }) => {
    await expect(canvas(page)).toHaveAttribute('data-loop', 'running');
    const setHidden = (hidden) =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    await setHidden(true);
    await expect(canvas(page)).toHaveAttribute('data-loop', 'paused');
    await setHidden(false);
    await expect(canvas(page)).toHaveAttribute('data-loop', 'running');
  });

  test('idle agents spread over the office and play different activities, never sharing a spot', async ({
    page,
    server,
  }) => {
    test.setTimeout(90_000);
    await page.clock.install();
    await login(page, server.dashboardToken);
    for (const role of ROLES)
      await server.emit({ agent: role, type: 'status', summary: 'idle', meta: { state: 'idle' } });
    await page.goto('/?office-seed=5');
    await expect
      .poll(async () => Number(await canvas(page).getAttribute('data-agents')))
      .toBeGreaterThanOrEqual(ROLES.length);
    const total = await canvas(page).getAttribute('data-agents'); // the seven roles (+ any earlier extra)
    const seen = new Set();
    for (let i = 0; i < 120; i++) {
      await page.clock.runFor(500); // 60 s of simulated time
      const states = (await canvas(page).getAttribute('data-states')) || '';
      const spots = (await canvas(page).getAttribute('data-spots')) || '';
      for (const entry of states.split(',')) seen.add(entry.split(':')[1]);
      const held = spots ? spots.split(',').map((e) => e.split(':')[1]) : [];
      expect(new Set(held).size, `a spot is held twice: ${spots}`).toBe(held.length);
      expect(await canvas(page).getAttribute('data-agents')).toBe(total);
    }
    const activities = ACTIVITY.filter((a) => seen.has(a));
    expect(activities.length, `saw ${[...seen]}`).toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: path.join(SHOTS, 'office-idle.png'), fullPage: true });
  });

  test('reduced motion: a celebration still ends without a frame loop', async ({
    authedPage: page,
    server,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(canvas(page)).toHaveAttribute('data-loop', 'static');
    await server.emit({ agent: 'verify', type: 'tool_start', tool: 'Bash', summary: 'Bash: ls', task: 'x' });
    await expectState(page, 'verify', /^typing$/);
    await server.emit({ agent: 'verify', type: 'subagent_stop', summary: 'finished' });
    await expectState(page, 'verify', /^celebrate$/);
    await expect(canvas(page)).toHaveAttribute('data-loop', 'static');
    // celebrateSecs is 3: it ends on a timer, with the loop still static and the agent not walking
    await expectState(page, 'verify', IDLE_OR_WALKING, 8_000);
    expect(await stateOf(page, 'verify')).not.toBe('walking');
    await expect(canvas(page)).toHaveAttribute('data-loop', 'static');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(canvas(page)).toHaveAttribute('data-loop', 'running');
  });

  test('an agent that leaves the snapshot loses its card and its character', async ({
    authedPage: page,
    server,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      const Real = window.EventSource;
      window.__streams = [];
      window.EventSource = class extends Real {
        constructor(...args) {
          super(...args);
          window.__streams.push(this);
        }
      };
    });
    await server.emit({ agent: 'orchestrator', type: 'status', summary: 'hi', meta: { state: 'idle' } });
    await page.reload();
    await expect(card(page, 'orchestrator')).toHaveCount(1);
    await expect.poll(() => canvas(page).getAttribute('data-states')).toContain('orchestrator:');
    const agentsBefore = Number(await canvas(page).getAttribute('data-agents'));
    // the next snapshot (when a resync is requested reconnects) no longer lists it
    await page.route('**/api/agents', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.agents = body.agents.filter((a) => a.id !== 'orchestrator');
      await route.fulfill({ response: res, json: body });
    });
    // ask the store for a resync the way the server does (a `resync` event on the stream)
    await page.evaluate(() => window.__streams.at(-1).dispatchEvent(new Event('resync')));
    await expect(card(page, 'orchestrator')).toHaveCount(0, { timeout: 30_000 });
    await expect(canvas(page)).toHaveAttribute('data-agents', String(agentsBefore - 1));
    expect((await canvas(page).getAttribute('data-states')) || '').not.toContain('orchestrator:');
    expect((await canvas(page).getAttribute('data-spots')) || '').not.toContain('orchestrator:');
  });

  test('a burst of resize events costs far fewer backing-store reallocations', async ({
    authedPage: page,
  }) => {
    await expect(canvas(page)).toHaveAttribute('data-fits', /\d+/);
    const fits = async () => Number(await canvas(page).getAttribute('data-fits'));
    const start = await fits();
    // fire the events synchronously, then let a frame pass
    await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const burst = (await fits()) - start;
    expect(burst).toBeLessThanOrEqual(1); // unchanged size: not even one
    // real viewport changes: one fit per size, and the last one matches the box
    const before = await fits();
    for (const w of [1200, 1000, 1200, 1000, 1100]) await page.setViewportSize({ width: w, height: 900 });
    await expect
      .poll(async () => {
        const f = await fitState(page);
        return fitsBox(f);
      })
      .toBe(true);
    expect((await fits()) - before).toBeLessThanOrEqual(5);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('an invalid layout shows a readable message instead of a blank office', async ({
    authedPage: page,
    problems,
  }) => {
    await page.route('**/office/layout.json', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 99 }) }),
    );
    await page.reload();
    await expect(page.locator('#conn')).toContainText('live');
    await expect(page.locator('#office .office-error')).toContainText('unsupported version 99');
    await expect(page.locator('#office canvas')).toHaveCount(0);
    // the rest of the dashboard still works
    await expect(card(page, 'code')).toBeVisible();
    expect(problems.splice(0).join('\n')).toContain('Invalid office layout');
  });

  test('the layout and atlas are served with the right types under the CSP', async ({ authedPage: page }) => {
    const urls = [];
    page.on('response', (r) => urls.push(new URL(r.url()).pathname));
    await page.reload();
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
    const prefix = /^\/v\/[0-9a-f]{12}\/office\//;
    const once = (file) => urls.filter((u) => u.endsWith(`/office/${file}`) && prefix.test(u));
    expect(once('layout.json')).toHaveLength(1);
    expect(once('atlas.json')).toHaveLength(1); // shared by the office and the portraits
    expect(once('atlas.png')).toHaveLength(1);
    expect(urls.some((u) => u.endsWith(`/office/${['tiles', 'png'].join('.')}`))).toBe(false);
    const png = await page.request.get(once('atlas.png')[0]);
    expect(png.headers()['content-type']).toBe('image/png');
    expect(png.headers()['x-content-type-options']).toBe('nosniff');
    const json = await page.request.get(once('atlas.json')[0]);
    expect(json.headers()['content-type']).toMatch(/^application\/json/);
    expect(json.headers()['x-content-type-options']).toBe('nosniff');
  });

  for (const file of ['atlas.png', 'atlas.json']) {
    test(`a missing ${file} shows a readable message instead of a blank or flat-coloured office`, async ({
      authedPage: page,
      problems,
    }) => {
      await page.route(`**/office/${file}`, (route) => route.fulfill({ status: 404, body: 'nope' }));
      await page.reload();
      await expect(page.locator('#conn')).toContainText('live');
      await expect(page.locator('#office .office-error')).toContainText('The office could not be drawn');
      await expect(page.locator('#office canvas')).toHaveCount(0);
      await expect(card(page, 'code')).toBeVisible(); // the rest of the dashboard still works
      await expect(card(page, 'code').locator('canvas.avatar')).toHaveCount(1); // blank, not broken
      expect(problems.splice(0).join('\n')).toContain('office');
    });
  }
});

const fitState = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('#office canvas.office-canvas');
    const r = c.getBoundingClientRect();
    return {
      canvas: r.width,
      attr: c.width,
      canvasH: r.height,
      box: document.querySelector('#office').clientWidth,
      // the height available to the canvas inside the capped box (Infinity below 768px, no cap)
      availH: (() => {
        const o = document.querySelector('#office');
        const cs = getComputedStyle(o);
        const cap = parseFloat(cs.maxHeight);
        return Number.isFinite(cap)
          ? cap - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)
          : Infinity;
      })(),
      dpr: window.devicePixelRatio,
    };
  });

// Fits its box: never larger than the box in either direction, and it fills the limiting direction
// (the width, or the 420px height cap on tablet and desktop) to within 8%.
const fitsBox = (f) =>
  f.canvas <= f.box + 0.01 &&
  f.canvasH <= f.availH + 0.01 &&
  (f.canvas >= 0.92 * f.box || f.canvasH >= 0.92 * f.availH);

test.describe('canvas office fits its box', () => {
  for (const [w, h] of [
    [1280, 900],
    [1024, 768],
    [900, 800],
    [800, 700],
    [700, 700],
  ]) {
    test(`${w}x${h} at DPR 1`, async ({ authedPage: page }) => {
      await page.setViewportSize({ width: w, height: h });
      await expect(page.locator('#office canvas')).toHaveAttribute('data-agents', /\d+/);
      await expect
        .poll(async () => {
          const f = await fitState(page);
          return fitsBox(f);
        })
        .toBe(true);
    });
  }

  test('re-fits live when the viewport is resized, without errors', async ({ authedPage: page }) => {
    await expect(page.locator('#office canvas')).toHaveAttribute('data-agents', /\d+/);
    const fitted = async (width) => {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(async () => {
          const f = await fitState(page);
          return fitsBox(f) ? f.attr : 0;
        })
        .toBeGreaterThan(0);
      return (await fitState(page)).attr;
    };
    const wide = await fitted(1280);
    const narrow = await fitted(900);
    expect(narrow).toBeLessThanOrEqual(wide); // both height-limited by the 420px cap at these widths
    expect(await fitted(1280)).toBe(wide);
    // `problems` (the fixture) verifies there were no console errors or CSP violations.
  });
});

for (const dpr of [1.5, 2]) {
  test.describe(`canvas office at device pixel ratio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('fills the box and keeps a device-resolution backing store', async ({ authedPage: page }) => {
      const c = page.locator('#office canvas.office-canvas');
      await expect(c).toHaveAttribute('data-agents', /\d+/);
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(dpr);
      await expect
        .poll(async () => {
          const f = await fitState(page);
          return fitsBox(f);
        })
        .toBe(true);
      const f = await fitState(page);
      expect(Math.abs(f.attr - Math.round(f.canvas * dpr))).toBeLessThanOrEqual(1);
      await expect(page.locator('[style]')).toHaveCount(1); // the canvas size, set through CSSOM
      // no seams or transparent holes at a fractional scale
      const px = await c.evaluate((cv) => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const seen = new Set();
        let transparent = 0;
        for (let i = 0; i < d.length; i += 4 * 97) {
          if (d[i + 3] === 0) transparent++;
          seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
        return { colours: seen.size, transparent };
      });
      expect(px.transparent).toBe(0);
      expect(px.colours).toBeGreaterThan(8);
    });
  });
}

test.describe('pipeline', () => {
  const base = { agent: 'orchestrator', type: 'pipeline' };
  // The panel being tested is the run most recently passed to pipe(); earlier tests leave their own
  // panels on the dashboard, so every selector below is scoped to one panel.
  let lastRun = null;
  const panel = (page, run = lastRun) => page.locator(`#pipeline [data-run-id="${run}"]`);
  const pipe = (run_id, meta, summary) => {
    lastRun = run_id;
    return { ...base, summary, meta: { run_id, repo: 'demo', branch: 'feat/x', ...meta } };
  };
  const stepOf = (page, label) => panel(page).locator('.stepper > li', { hasText: label });
  const chip = (page, step, sub) => stepOf(page, step).locator(`.substep[data-substep="${sub}"]`);

  test('merged agents (legacy step names): one verify card whose indicator follows the active gate', async ({
    authedPage: page,
    server,
  }) => {
    const canvas = page.locator('#office canvas');
    const indicators = () => canvas.getAttribute('data-indicators').then((v) => v || '');
    const verify = card(page, 'verify');
    await expect(page.locator('#agents article[aria-label="Agent verify"]')).toHaveCount(1);
    await expect(verify.locator('.step-line')).toBeHidden();

    await server.emit({ agent: 'verify', type: 'status', task: 'Gate', summary: 'starting' });
    // working with no known step renders as before
    await expect(verify.locator('.badge')).toHaveText(/WORKING/);
    await expect(verify.locator('.step-line')).toBeHidden();

    await server.emit(pipe('run-ind-a', { step: 'test', state: 'active' }));
    await expect(verify.locator('.step-line')).toHaveText('TEST');
    await expect.poll(indicators).toContain('verify:flask');

    await server.emit(pipe('run-ind-a', { step: 'test', state: 'passed' }));
    await server.emit(pipe('run-ind-a', { step: 'styling', state: 'active' }));
    await expect(verify.locator('.step-line')).toHaveText('STYLING');
    await expect.poll(indicators).toContain('verify:brush');
    await expect(page.locator('#agents article[aria-label="Agent verify"]')).toHaveCount(1);

    // a parallel run: the newest active step wins and the other one is listed on the card
    await server.emit(pipe('run-ind-b', { step: 'test', state: 'active', repo: 'other' }));
    await expect(verify.locator('.step-line')).toHaveText('TEST');
    await expect(verify.locator('.step-extra')).toContainText('STYLING');

    await server.emit(pipe('run-ind-b', { step: 'test', state: 'passed', repo: 'other' }));
    await expect(verify.locator('.step-line')).toHaveText('STYLING');
    await server.emit(pipe('run-ind-a', { step: 'styling', state: 'passed' }));
    await expect(verify.locator('.step-line')).toBeHidden();
    await expect.poll(indicators).not.toContain('verify:');

    // review maps security / code-review; legacy names never create a card
    await server.emit({ agent: 'review', type: 'status', task: 'Review', summary: 'starting' });
    await server.emit(pipe('run-ind-a', { step: 'code-review', state: 'active' }));
    await expect(card(page, 'review').locator('.step-line')).toHaveText('CODE REVIEW');
    await expect.poll(indicators).toContain('review:magnifier');
    await expect(page.locator('#agents article[aria-label="Agent code-review"]')).toHaveCount(0);

    // done clears the icon
    await server.emit({ agent: 'review', type: 'subagent_stop', summary: 'finished' });
    await expect(card(page, 'review').locator('.badge')).toHaveText(/DONE/);
    await expect(card(page, 'review').locator('.step-line')).toBeHidden();
    await expect.poll(indicators).not.toContain('review:');

    // the legacy pipeline names never brought a retired card back
    for (const retired of ['test', 'styling', 'security', 'code-review']) {
      await expect(page.locator(`#agents article[aria-label="Agent ${retired}"]`)).toHaveCount(0);
    }
  });

  test('stepper has 8 steps with substep chips; failed substep text; no gate entries', async ({
    authedPage: page,
    server,
  }) => {
    const run = 'run-sub';
    await server.emit(pipe(run, { step: 'spec', state: 'passed' }));
    await server.emit(pipe(run, { step: 'verify', state: 'active' }));
    await server.emit(pipe(run, { step: 'verify', substep: 'test', state: 'passed' }));
    await server.emit(pipe(run, { step: 'verify', substep: 'styling', state: 'active' }));
    const items = panel(page).locator('.stepper > li');
    await expect(items).toHaveCount(8);
    await expect(items).toHaveText([
      /Spec/,
      /Code/,
      /Verify/,
      /Review/,
      /User approval/,
      /Merge/,
      /Deploy/,
      /Cleanup/,
    ]);
    await expect(chip(page, 'Verify', 'test')).toContainText('PASSED');
    await expect(chip(page, 'Verify', 'styling')).toContainText('ACTIVE');
    await expect(chip(page, 'Review', 'security')).toContainText('PENDING');
    await expect(chip(page, 'Review', 'code-review')).toContainText('PENDING');
    await expect(stepOf(page, 'Verify')).toContainText('ACTIVE');
    // a substep event never resets other steps
    await expect(stepOf(page, 'Spec')).toContainText('PASSED');

    await server.emit(
      pipe(run, { step: 'verify', substep: 'styling', state: 'failed', attempt: 1 }, 'prettier: 2 files'),
    );
    await expect(stepOf(page, 'Verify')).toContainText('FAILED at Styling');
    await expect(chip(page, 'Verify', 'styling')).toContainText('FAILED');
    await expect(stepOf(page, 'Verify')).toHaveAttribute('aria-label', 'Verify: FAILED at Styling');
    await expect(panel(page).locator('.pipe-fail')).toContainText('Last failed gate: styling');
    // legacy names for the other agent merge into the same parent
    await server.emit(pipe(run, { step: 'security', state: 'active' }));
    await expect(chip(page, 'Review', 'security')).toContainText('ACTIVE');
    await expect(panel(page).locator('.stepper > li', { hasText: /^Security/ })).toHaveCount(0);
  });

  test('card label and icon follow the substep; parent alone is text; parallel runs list Also', async ({
    authedPage: page,
    server,
  }) => {
    const canvas = page.locator('#office canvas');
    const indicators = () => canvas.getAttribute('data-indicators').then((v) => v || '');
    const verify = card(page, 'verify');
    await server.emit({ agent: 'verify', type: 'status', task: 'Gate', summary: 'starting' });
    await server.emit(pipe('sub-a', { step: 'verify', state: 'active' }));
    await expect(verify.locator('.step-line')).toHaveText('VERIFY');
    await expect(verify.locator('.step-line .step-icon')).toHaveCount(0);
    await expect(verify).toHaveAttribute('data-step', 'verify');
    await expect(verify).toHaveAttribute('data-substep', '');
    await expect.poll(indicators).not.toContain('verify:');

    await server.emit(pipe('sub-a', { step: 'verify', substep: 'test', state: 'active' }));
    await expect(verify.locator('.step-line')).toHaveText('TEST');
    await expect(verify.locator('.step-extra')).toBeHidden();
    await expect(verify).toHaveAttribute('data-substep', 'test');
    await expect.poll(indicators).toContain('verify:flask');

    await server.emit(pipe('sub-b', { step: 'verify', substep: 'styling', state: 'active', repo: 'other' }));
    await expect(verify.locator('.step-line')).toHaveText('STYLING');
    await expect(verify.locator('.step-extra')).toHaveText('Also: TEST (demo)');
    await expect.poll(indicators).toContain('verify:brush');

    await server.emit({ agent: 'review', type: 'status', task: 'Review', summary: 'starting' });
    await server.emit(pipe('sub-a', { step: 'review', substep: 'security', state: 'active' }));
    await expect(card(page, 'review').locator('.step-line')).toHaveText('SECURITY');
    await expect.poll(indicators).toContain('review:shield');
    await expect(page.locator('#agents article[aria-label="Agent security"]')).toHaveCount(0);
  });

  test('reduced motion: substep icon and chip changes do not animate', async ({
    authedPage: page,
    server,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const indicators = () =>
      page
        .locator('#office canvas')
        .getAttribute('data-indicators')
        .then((v) => v || '');
    await server.emit({ agent: 'verify', type: 'status', task: 'Gate', summary: 'starting' });
    await server.emit(pipe('rm', { step: 'verify', substep: 'test', state: 'active' }));
    await expect.poll(indicators).toContain('verify:flask');
    await server.emit(pipe('rm', { step: 'verify', substep: 'test', state: 'passed' }));
    await server.emit(pipe('rm', { step: 'verify', substep: 'styling', state: 'active' }));
    await expect.poll(indicators).toContain('verify:brush');
    const anim = await chip(page, 'Verify', 'styling').evaluate((el) => [
      getComputedStyle(el).animationName,
      getComputedStyle(el.closest('.step'), '::before').animationName,
    ]);
    expect(anim).toEqual(['none', 'none']);
  });

  test('retry: Review passed without re-run shows SKIPPED chips, not PENDING', async ({
    authedPage: page,
    server,
  }) => {
    const run = 'run-skip';
    await server.emit(pipe(run, { step: 'verify', substep: 'test', state: 'passed' }));
    await server.emit(pipe(run, { step: 'verify', substep: 'styling', state: 'passed' }));
    await server.emit(pipe(run, { step: 'code', state: 'active', attempt: 2 }));
    await server.emit(pipe(run, { step: 'review', state: 'passed' }, 'unchanged, not re-run'));
    await expect(stepOf(page, 'Review')).toContainText('PASSED');
    for (const sub of ['security', 'code-review']) {
      const c = chip(page, 'Review', sub);
      await expect(c).toContainText('SKIPPED');
      await expect(c).toContainText('–');
      await expect(c).not.toContainText('PENDING');
      await expect(c).toHaveClass(/s-skipped/);
    }
    await expect(chip(page, 'Review', 'security')).toHaveAttribute('aria-label', /skipped/);
    const anim = await chip(page, 'Review', 'security').evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe('none');
  });

  test('an unknown event through the API does not create a card', async ({ authedPage: page, server }) => {
    await server.emit({ agent: 'unknown', type: 'status', task: 'Elsewhere', summary: 'other repo' });
    await server.emit({ agent: 'verify', type: 'status', task: 'Gate', summary: 'marker' });
    await expect(card(page, 'verify').locator('.badge')).toHaveText(/WORKING/);
    await expect(page.locator('#agents article[aria-label="Agent unknown"]')).toHaveCount(0);
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test('stepper with skipped chips does not scroll horizontally', async ({ authedPage: page, server }) => {
      await server.emit(pipe('ph-skip', { step: 'review', state: 'passed' }, 'x'.repeat(80)));
      await expect(chip(page, 'Review', 'security')).toContainText('SKIPPED');
      const m = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(m.s).toBeLessThanOrEqual(m.c);
    });
    test('stepper with substep chips does not scroll horizontally', async ({ authedPage: page, server }) => {
      await server.emit(pipe('ph', { step: 'verify', substep: 'styling', state: 'failed' }, 'x'.repeat(80)));
      await expect(chip(page, 'Verify', 'styling')).toContainText('FAILED');
      const m = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(m.s).toBeLessThanOrEqual(m.c);
    });
  });

  test('attempt counter, failed gate, last failure and approval banner', async ({
    authedPage: page,
    server,
  }) => {
    const run = 'run-approval';
    await server.emit(pipe(run, { step: 'spec', state: 'passed' }));
    await server.emit(pipe(run, { step: 'code', state: 'passed' }));
    await server.emit(
      pipe(run, { step: 'test', state: 'failed', attempt: 1, failed_gate: 'test' }, 'npm test: 2 failing'),
    );

    const p = panel(page);
    await expect(p).toContainText('Attempt 1 of 3');
    await expect(p.locator('.pipe-fail')).toHaveText('Last failed gate: test - npm test: 2 failing');
    await expect(stepOf(page, 'Verify')).toContainText('FAILED at Test');
    await expect(chip(page, 'Verify', 'test')).toContainText('FAILED');
    await expect(stepOf(page, 'Verify')).toHaveAttribute('aria-label', 'Verify: FAILED at Test');
    await expect(stepOf(page, 'Spec')).toContainText('PASSED');

    await server.emit(pipe(run, { step: 'code', state: 'active', attempt: 2 }));
    await expect(p).toContainText('Attempt 2 of 3');
    await expect(stepOf(page, 'Verify')).toContainText('PENDING');
    await expect(chip(page, 'Verify', 'test')).toContainText('PENDING');

    for (const step of ['code', 'test', 'security', 'styling', 'code-review']) {
      await server.emit(pipe(run, { step, state: 'passed', attempt: 2 }));
    }
    await server.emit(
      pipe(run, {
        step: 'user-approval',
        state: 'active',
        pr_url: 'https://github.com/o/r/pull/1',
        commit_sha: 'abcdef1234567890',
      }),
    );
    // the banner lives inside this run's panel; there is no global approval element
    const banner = p.getByRole('alert');
    await expect(banner).toHaveText(/WAITING ON USER APPROVAL/);
    await expect(banner).toBeVisible();
    await expect(page.locator('#approval')).toHaveCount(0);
    // section-level collapse still hides the whole pipeline body
    await toggle(page, 'pipeline').click();
    await expect(page.locator('#pipeline')).toBeHidden();
    await toggle(page, 'pipeline').click();
    await expect(p).toContainText('demo / feat/x / abcdef1234');
    await expect(p).toContainText('PR: https://github.com/o/r/pull/1');
    await expect(stepOf(page, 'User approval')).toContainText('ACTIVE');
  });

  test.describe('multiple panels', () => {
    const ids = [1, 2, 3, 4, 5].map((i) => `par-aaa00${i}`);
    const parallel = (page) => page.locator('#pipeline [data-run-id^="par-"]');
    const emitParallel = async (server) => {
      for (const [i, id] of ids.entries()) {
        await server.emit({
          ...base,
          meta: {
            run_id: id,
            repo: `par-repo-${i + 1}`,
            branch: `feat/par-${i + 1}`,
            step: 'code',
            state: 'active',
            attempt: (i % 3) + 1,
          },
        });
      }
    };

    test('five parallel runs show five panels, each with its own repo, branch and attempt', async ({
      authedPage: page,
      server,
    }) => {
      await emitParallel(server);
      await expect(parallel(page)).toHaveCount(5);
      for (const [i, id] of ids.entries()) {
        const head = panel(page, id).locator('.pipe-panel-head');
        await expect(head).toContainText(`par-repo-${i + 1} / feat/par-${i + 1}`);
        await expect(head).toContainText(`run …${id.slice(-6)}`);
        await expect(head).toContainText(`Attempt ${(i % 3) + 1} of 3`);
        await expect(head).toContainText('status: running');
        await expect(panel(page, id).locator('.stepper > li')).toHaveCount(8);
      }
      // new panels append in start order
      await expect(parallel(page)).toHaveText(
        [/par-repo-1/, /par-repo-2/, /par-repo-3/, /par-repo-4/, /par-repo-5/],
        {
          useInnerText: false,
        },
      );
    });

    test('a run waiting on approval shows the banner only in its own panel', async ({
      authedPage: page,
      server,
    }) => {
      await emitParallel(server);
      await server.emit({ ...base, meta: { run_id: ids[2], step: 'user-approval', state: 'active' } });
      await expect(panel(page, ids[2]).getByRole('alert')).toHaveText(/WAITING ON USER APPROVAL/);
      for (const id of ids.filter((x) => x !== ids[2])) {
        await expect(panel(page, id).getByRole('alert')).toHaveCount(0);
      }
    });

    test('collapsing one panel hides its body and keeps the others open', async ({
      authedPage: page,
      server,
    }) => {
      await emitParallel(server);
      const btn = (id) => panel(page, id).locator('.pipe-panel-toggle');
      const body = (id) => panel(page, id).locator('.pipe-panel-body');
      await expect(parallel(page)).toHaveCount(5);
      for (const id of ids) await expect(btn(id)).toHaveAttribute('aria-expanded', 'true');
      await btn(ids[0]).click();
      await expect(btn(ids[0])).toHaveAttribute('aria-expanded', 'false');
      await expect(body(ids[0])).toBeHidden();
      await expect(btn(ids[0])).toBeVisible();
      for (const id of ids.slice(1)) {
        await expect(btn(id)).toHaveAttribute('aria-expanded', 'true');
        await expect(body(id)).toBeVisible();
      }
      expect(await btn(ids[0]).getAttribute('aria-controls')).toBe(await body(ids[0]).getAttribute('id'));
      // the state survives a re-render from a new event, and nothing is persisted
      await server.emit({ ...base, meta: { run_id: ids[0], step: 'verify', state: 'active' } });
      await expect(panel(page, ids[0]).locator('.pipe-panel-head')).toContainText('status: running');
      await expect(btn(ids[0])).toHaveAttribute('aria-expanded', 'false');
      expect(
        await page.evaluate(() => Object.keys(localStorage).filter((k) => /pipe|panel|run/i.test(k))),
      ).toEqual([]);
      await btn(ids[0]).click();
      await expect(body(ids[0])).toBeVisible();
    });

    for (const [w, h] of [
      [375, 800],
      [768, 900],
      [1280, 900],
      [1920, 1000],
    ]) {
      test(`${w}px with five panels has no horizontal scroll`, async ({ authedPage: page, server }) => {
        await page.setViewportSize({ width: w, height: h });
        await emitParallel(server);
        await expect(parallel(page)).toHaveCount(5);
        const m = await page.evaluate(() => ({
          s: document.documentElement.scrollWidth,
          c: document.documentElement.clientWidth,
        }));
        expect(m.s).toBeLessThanOrEqual(m.c);
        if (w === 375)
          await page.screenshot({ path: path.join(SHOTS, 'multi-panels-375.png'), fullPage: true });
      });
    }
  });

  const outcomes = [
    ['success', 'Deploy: SUCCESS', 'pipe-deploy-ok'],
    ['failure_rolled_back', 'Deploy: FAILED, rolled back', 'pipe-fail'],
    ['failure_rollback_failed', 'Deploy: FAILED, ROLLBACK FAILED', 'pipe-fail'],
  ];
  for (const [result, text, cls] of outcomes) {
    test(`deploy result ${result}`, async ({ authedPage: page, server }) => {
      const run = `run-${result}`;
      await server.emit(pipe(run, { step: 'merge', state: 'passed' }));
      await server.emit(pipe(run, { step: 'deploy', deploy_result: result }, 'deploy finished'));
      const el = panel(page).locator('.pipe-meta').getByText(text, { exact: true });
      await expect(el).toBeVisible();
      await expect(el).toHaveClass(new RegExp(cls));
      await expect(stepOf(page, 'Deploy')).toContainText(result === 'success' ? 'PASSED' : 'FAILED');
      await expect(panel(page).getByRole('alert')).toHaveCount(0);
    });
  }
});

test.describe('xss', () => {
  test('event text is rendered as literal text and nothing executes', async ({
    authedPage: page,
    server,
  }) => {
    const img = '<img src=x onerror="window.__pwned=1">';
    const script = '<script>window.__pwned=2</script>';
    await page.evaluate(() => {
      window.__pwned = 0;
    });
    await server.emit({ agent: 'cleanup', type: 'status', task: img, summary: `${script} ${img}` });
    await server.emit({
      agent: 'cleanup',
      type: 'pipeline',
      summary: img,
      meta: { run_id: 'run-xss', step: 'test', state: 'failed', failed_gate: img },
    });

    await expect(card(page, 'cleanup').locator('.task')).toHaveText(img);
    await expect(page.locator('#feed')).toContainText(script);
    await expect(page.locator('#pipeline [data-run-id="run-xss"] .pipe-fail')).toContainText(img);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    await expect(page.locator('main img, main script')).toHaveCount(0);
    // Same after a full reload (data now comes from the REST snapshot rather than SSE).
    await page.reload();
    await expect(card(page, 'cleanup').locator('.task')).toHaveText(img);
    await expect(page.locator('main img, main script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned ?? 0)).toBe(0);
  });
});

test.describe('activity rows (non-feature runs)', () => {
  const act = (run_id, kind, state, extra = {}, summary) => ({
    agent: 'orchestrator',
    type: 'pipeline',
    summary,
    meta: { run_id, kind, state, ...extra },
  });

  test('question and server_task rows, stepper untouched, text-only rendering', async ({
    authedPage: page,
    server,
  }) => {
    const img = '<img src=x onerror="window.__pwned=3">';
    await page.evaluate(() => {
      window.__pwned = 0;
    });
    await server.emit({
      agent: 'orchestrator',
      type: 'pipeline',
      meta: { run_id: 'feat-1', step: 'spec', state: 'passed', repo: 'demo' },
    });
    await server.emit(act('q-1', 'question', 'active', { target: 'example-app' }, 'How does auth work?'));
    const row = page.locator('#activity .act', { hasText: 'How does auth work?' });
    await expect(row).toContainText('Question');
    await expect(row).toContainText('example-app');
    await expect(row).toContainText('ACTIVE');
    await expect(row).toContainText('running');
    await server.emit(act('q-1', 'question', 'passed', { target: 'example-app' }, 'How does auth work?'));
    await expect(row).toContainText('PASSED');
    await expect(row).not.toContainText('running');

    await server.emit(act('s-1', 'server_task', 'failed', { target: 'app-server' }, img));
    const failed = page.locator('#activity .act', { hasText: 'FAILED' });
    await expect(failed).toContainText('Server task');
    await expect(failed).toContainText('app-server');
    await expect(failed).toContainText(img);
    await server.emit(
      act('r-1', 'single_role', 'active', { step: 'test', target: 'example-app' }, 'run test'),
    );
    await expect(page.locator('#activity .act', { hasText: 'Single role: test' })).toBeVisible();

    // the feature stepper is not replaced by any of this
    const feat = page.locator('#pipeline [data-run-id="feat-1"]');
    await expect(feat.locator('.stepper')).toBeVisible();
    await expect(feat.locator('.stepper li', { hasText: 'Spec' })).toContainText('PASSED');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__pwned)).toBe(0);
    await expect(page.locator('main img')).toHaveCount(0);
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test('activity rows do not cause horizontal scroll', async ({ authedPage: page, server }) => {
      await server.emit(
        act('q-2', 'question', 'active', { target: 'x'.repeat(90) }, 'long-unbroken-'.repeat(25)),
      );
      await expect(page.locator('#activity .act', { hasText: 'long-unbroken' })).toBeVisible();
      const m = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(m.s).toBeLessThanOrEqual(m.c);
    });
  });
});

test.describe('cost sections', () => {
  const usage = {
    'claude-opus-5-5': {
      input: 1000,
      output: 500,
      cache_write_5m: 2000,
      cache_write_1h: 0,
      cache_read: 40000,
    },
    'mystery-model': { input: 10, output: 5 },
  };

  test('cost summary and per-session list render computed costs, unpriced notes and live updates', async ({
    authedPage: page,
    server,
  }) => {
    await expect(page.getByRole('heading', { name: 'Cost summary' })).toBeVisible();
    await openSection(page, 'costs');
    await openSection(page, 'sessions');

    await server.emit({
      agent: 'code',
      session_id: 'costsess:a1',
      type: 'subagent_stop',
      usage,
      repo: 'demo',
    });
    await server.emit({
      agent: 'verify',
      session_id: 'oldsess',
      type: 'subagent_stop',
      tokens_in: 900,
      tokens_out: 10,
    });

    // 1000*4 + 500*20 + 2000*5 + 40000*0.2 = 0.004 + 0.01 + 0.01 + 0.008 per 1M -> $0.0320
    const costs = page.locator('#costs');
    await expect(costs.getByRole('table', { name: 'Cost by model' })).toContainText('claude-opus-5-5');
    await expect(costs.getByRole('table', { name: 'Cost by model' })).toContainText('claude-opus-5-5');
    await expect(costs.getByRole('table', { name: 'Cost by agent' })).toContainText('code');
    await expect(costs.getByRole('table', { name: 'Cost by day (UTC)' })).toBeVisible();
    await expect(costs.getByRole('table', { name: 'Tokens by class' })).toContainText('Cache read');
    await expect(costs.getByRole('note')).toContainText('could not be priced');
    await expect(costs.getByRole('note')).toContainText('mystery-model');

    const sessions = page.locator('#sessions');
    await expect(sessions.getByRole('row', { name: /costsess/ })).toContainText('$0.0320');
    await expect(sessions.getByRole('row', { name: /oldsess/ })).toContainText('unpriced');
    await expect(card(page, 'code')).toContainText('$0.0320');

    // a later event updates the section without a reload
    await server.emit({
      agent: 'code',
      session_id: 'costsess:a1',
      type: 'subagent_stop',
      usage: { 'claude-opus-5-5': { output: 1000000 } },
    });
    await expect(sessions.getByRole('row', { name: /costsess/ })).toContainText('$20.0320');

    await page.locator('#costs-days').selectOption('30');
    await expect(page.locator('#costs-summary')).toContainText('Last 30 days');
  });

  test.describe('phone viewport', () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test('cost sections do not cause horizontal scroll', async ({ authedPage: page, server }) => {
      await server.emit({
        agent: 'code',
        session_id: 'narrow-session-' + 'x'.repeat(40),
        type: 'subagent_stop',
        usage: {
          ['claude-opus-5-5-' + '2'.repeat(40)]: { input: 1, output: 1 },
          'claude-opus-5-5': { input: 5 },
        },
      });
      await openSection(page, 'costs');
      await openSection(page, 'sessions');
      await expect(page.locator('#costs')).toContainText('Cost by model');
      await expect(page.locator('#sessions')).toContainText('narrow-sessi');
      const m = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
    });
  });
});

test.describe('phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal page scroll', async ({ authedPage: page, server }) => {
    await server.emit({
      agent: 'code',
      type: 'tool_start',
      tool: 'Bash',
      summary: 'Bash: ' + 'a-very-long-unbroken-command-name-'.repeat(8),
      task: 'x'.repeat(150),
    });
    await expect(page.locator('#feed')).toContainText('a-very-long-unbroken');
    await expect(page.locator('#pipeline .stepper').first()).toBeVisible();
    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyW: document.body.scrollWidth,
    }));
    expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
    expect(m.bodyW).toBeLessThanOrEqual(m.clientW);
    await expect(page.locator('#office canvas')).toHaveAttribute('data-agents', /\d+/);
    // the office scrolls inside its own box instead of widening the page
    const office = await page.locator('#office').evaluate((el) => ({
      box: el.getBoundingClientRect().width,
      scroll: el.scrollWidth,
    }));
    expect(office.box).toBeLessThanOrEqual(375);
    expect(office.scroll).toBeGreaterThan(office.box);
    // never shrunk below 640 CSS px
    expect((await page.locator('#office canvas').boundingBox()).width).toBeGreaterThanOrEqual(639.5);
    await page.screenshot({ path: path.join(SHOTS, 'phone.png'), fullPage: true });
  });

  test('login page fits too', async ({ page }) => {
    await page.goto('/login');
    const m = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(m[0]).toBeLessThanOrEqual(m[1]);
  });
});

test.describe('logout', () => {
  test('ends the session and data is unreadable afterwards', async ({ page, server }) => {
    await login(page, server.dashboardToken);
    expect((await page.request.get('/api/agents')).status()).toBe(200);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    for (const url of ['/api/agents', '/api/events', '/api/pipeline', '/api/stream']) {
      const r = await page.request.get(url, { maxRedirects: 0 });
      expect(r.status(), url).toBe(401);
    }
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#agents')).toHaveCount(0);
  });

  test('an open dashboard is sent to /login once its session is gone', async ({ page, server, problems }) => {
    await login(page, server.dashboardToken);
    // Kill the session from a second request context sharing the cookie, as another tab would.
    await page.request.post('/logout', { maxRedirects: 0 });
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
    // The rejected SSE/REST requests are logged by the browser; anything else would be a real problem.
    for (const p of problems.splice(0)) expect(p).toContain('status of 401');
  });
});

test.describe('office zoom', () => {
  const canvas = (page) => page.locator('#office canvas.office-canvas');
  const toolbar = (page) => page.getByRole('group', { name: 'Office zoom' });
  const zin = (page) => toolbar(page).getByRole('button', { name: 'Zoom in' });
  const zout = (page) => toolbar(page).getByRole('button', { name: 'Zoom out' });
  const zreset = (page) => toolbar(page).getByRole('button', { name: 'Reset zoom to fit' });
  const ready = async (page) => {
    await expect(canvas(page)).toHaveAttribute('data-zoom', /\d/);
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
  };
  const zoomOf = (page) => canvas(page).getAttribute('data-zoom');
  const widthOf = (page) => canvas(page).evaluate((c) => c.getBoundingClientRect().width);
  const noSideways = (page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test('the toolbar is a labelled group of three named buttons outside the aria-hidden office', async ({
    authedPage: page,
  }) => {
    await ready(page);
    await expect(toolbar(page)).toBeVisible();
    await expect(toolbar(page).getByRole('button')).toHaveCount(3);
    await expect(zreset(page)).toHaveText('1x');
    expect(await toolbar(page).evaluate((el) => !!el.closest('[aria-hidden="true"]'))).toBe(false);
    expect(
      await toolbar(page).evaluate((el) => el.parentElement.contains(document.getElementById('office'))),
    ).toBe(true);
    for (const b of await toolbar(page).getByRole('button').all()) {
      const box = await b.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.width).toBeGreaterThanOrEqual(32);
    }
    await expect(zout(page)).toBeDisabled();
    await expect(zin(page)).toBeEnabled();
    await expect(page.locator('[style]')).toHaveCount(0);
    // visible keyboard focus
    await zin(page).focus();
    expect(await zin(page).evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  });

  test('zoom 2 is about twice as wide, scrolls inside the box and never widens the page', async ({
    authedPage: page,
  }) => {
    await ready(page);
    const w1 = await widthOf(page);
    const s1 = Number(await canvas(page).getAttribute('data-scale'));
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '2');
    await expect.poll(() => widthOf(page)).toBeGreaterThan(w1 * 1.8);
    const w2 = await widthOf(page);
    expect(w2).toBeLessThan(w1 * 2.1);
    expect(Number(await canvas(page).getAttribute('data-scale'))).toBeGreaterThan(s1 * 1.8);
    await expect(zreset(page)).toHaveText('2x');
    const box = await page.locator('#office').evaluate((el) => ({
      zoomed: el.classList.contains('zoomed'),
      sw: el.scrollWidth,
      cw: el.clientWidth,
      sh: el.scrollHeight,
      ch: el.clientHeight,
    }));
    expect(box.zoomed).toBe(true);
    expect(box.sw).toBeGreaterThan(box.cw);
    expect(box.sh).toBeGreaterThanOrEqual(box.ch);
    expect(await noSideways(page)).toBe(true);
    await expect(page.locator('[style]')).toHaveCount(0);
    await zreset(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '1');
    await expect.poll(() => widthOf(page)).toBeCloseTo(w1, 0);
    await expect(page.locator('#office')).not.toHaveClass(/zoomed/);
    await page.screenshot({ path: path.join(SHOTS, 'office-zoom-reset.png') });
  });

  test('buttons are disabled at the bounds and the keys + - 0 work with focus in the toolbar', async ({
    authedPage: page,
  }) => {
    await ready(page);
    await zin(page).focus();
    await page.keyboard.press('Enter');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '2');
    await page.keyboard.press('Space');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    await page.keyboard.press('+');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '4');
    await expect(zin(page)).toBeDisabled();
    await expect(zout(page)).toBeEnabled();
    // focus stays inside the toolbar when the focused button becomes disabled
    await expect.poll(() => toolbar(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('-');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    await page.keyboard.press('=');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '4');
    await page.keyboard.press('0');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '1');
    await expect(zout(page)).toBeDisabled();
    await page.keyboard.press('-');
    await expect(canvas(page)).toHaveAttribute('data-zoom', '1');
    // Tab reaches the buttons in order
    await page.locator('#office').evaluate(() => document.activeElement?.blur());
    await zout(page)
      .focus()
      .catch(() => {});
    expect(await zoomOf(page)).toBe('1');
    expect(await noSideways(page)).toBe(true);
  });

  test('zoom keeps the visible centre', async ({ authedPage: page }) => {
    await ready(page);
    // zoom multiplies the fitted (height-capped) scene width, so pan from zoom 3, where it overflows widely
    await zin(page).click();
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    const frac = () =>
      page.locator('#office').evaluate((el) => ({
        x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
        y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
      }));
    await page.locator('#office').evaluate((el) => {
      el.scrollLeft = el.scrollWidth; // far right
      el.scrollTop = 0;
    });
    const before = await frac();
    expect(before.x).toBeGreaterThan(0.6);
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '4');
    await expect.poll(async () => Math.abs((await frac()).x - before.x)).toBeLessThan(0.03);
    expect(Math.abs((await frac()).y - before.y)).toBeLessThan(0.05);
  });

  test('the level persists across reloads and survives a resize', async ({ authedPage: page }) => {
    await ready(page);
    await zin(page).click();
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    expect(await page.evaluate(() => localStorage.getItem('office.zoom'))).toBe('3');
    await page.reload();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    await expect(zreset(page)).toHaveText('3x');
    await page.setViewportSize({ width: 900, height: 800 });
    await expect.poll(() => widthOf(page)).toBeGreaterThan(900);
    expect(await zoomOf(page)).toBe('3');
    expect(await noSideways(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await zreset(page).click();
    expect(await page.evaluate(() => localStorage.getItem('office.zoom'))).toBe('1');
  });

  test('invalid stored values are ignored', async ({ authedPage: page }) => {
    for (const bad of ['9', '0', '2.5', 'abc', '']) {
      await page.evaluate((v) => localStorage.setItem('office.zoom', v), bad);
      await page.reload();
      await ready(page);
      expect(await zoomOf(page), JSON.stringify(bad)).toBe('1');
    }
    await page.evaluate(() => localStorage.removeItem('office.zoom'));
  });

  test('blocked storage leaves the office working at zoom 1 and zoom still works', async ({
    page,
    server,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await login(page, server.dashboardToken);
    await ready(page);
    expect(await zoomOf(page)).toBe('1');
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '2');
    await expect(page.locator('#office .office-error')).toHaveCount(0);
  });

  test('the mouse wheel scrolls normally and never zooms', async ({ authedPage: page }) => {
    await ready(page);
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.mouse.move(640, 300);
    await page.locator('#office').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 300);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    expect(await zoomOf(page)).toBe('1');
    // zoomed, the wheel pans the box inside itself
    await zin(page).click();
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    const box = await page.locator('#office').boundingBox();
    await page.mouse.move(box.x + box.width / 2, Math.max(box.y, 0) + 50);
    await page.mouse.wheel(300, 0);
    await expect.poll(() => page.locator('#office').evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await zoomOf(page)).toBe('3');
    await zreset(page).click();
  });

  test('a phone-width viewport still never scrolls sideways when zoomed', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await ready(page);
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '2');
    expect(await noSideways(page)).toBe(true);
    const tb = await toolbar(page).boundingBox();
    expect(tb.x + tb.width).toBeLessThanOrEqual(375);
    await zreset(page).click();
  });

  test('screenshots of the toolbar at zoom 1 and zoom 3', async ({ authedPage: page }) => {
    await ready(page);
    const area = page.locator('.office-section');
    await area.screenshot({ path: path.join(SHOTS, 'office-zoom-1.png') });
    await zin(page).click();
    await zin(page).click();
    await expect(canvas(page)).toHaveAttribute('data-zoom', '3');
    await page.waitForTimeout(300);
    await area.screenshot({ path: path.join(SHOTS, 'office-zoom-3.png') });
    await zreset(page).click();
  });
});

test.describe('office layout override', () => {
  const OVERRIDE = '**/api/office-layout';
  const canvas = (page) => page.locator('#office canvas.office-canvas');
  const bundledLayout = () =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'office', 'layout.json'), 'utf8'));
  // the top-left wall tile removed (showing the floor): a valid, visibly different layout
  const withGrassCorner = () => {
    const l = bundledLayout();
    l.layers.walls[0] = `.${l.layers.walls[0].slice(1)}`;
    return l;
  };
  const corner = (page) =>
    canvas(page).evaluate((c) => {
      const s = c.width / 1024;
      const d = c.getContext('2d').getImageData(Math.floor(8 * s), Math.floor(8 * s), 1, 1).data;
      return [...d].join(',');
    });

  test('unset: the endpoint is a 404 and the bundled layout is drawn without a banner', async ({
    authedPage: page,
  }) => {
    const r = await page.request.get('/api/office-layout');
    expect(r.status()).toBe(404);
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
    await expect(page.locator('#office .office-error')).toHaveCount(0);
  });

  test('an unauthenticated request is rejected', async ({ playwright, server }) => {
    const ctx = await playwright.request.newContext({ baseURL: server.base });
    const r = await ctx.get('/api/office-layout', { maxRedirects: 0 });
    expect(r.status()).toBe(401);
    await ctx.dispose();
  });

  test('a valid override is used', async ({ authedPage: page }) => {
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
    const bundledCorner = await corner(page);
    let hits = 0;
    await page.route(OVERRIDE, (route) => {
      hits++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(withGrassCorner()) });
    });
    await page.reload();
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
    expect(hits).toBeGreaterThan(0);
    await expect.poll(() => corner(page)).not.toBe(bundledCorner);
    await expect(page.locator('#office .office-error')).toHaveCount(0);
  });

  test('an invalid override falls back to the bundled layout with a console warning and no banner', async ({
    authedPage: page,
    problems,
  }) => {
    const warnings = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
    const bundledCorner = await corner(page);
    const bad = [
      { ...withGrassCorner(), version: 99 },
      (() => {
        // no desk spots: rejected by the validator
        const l = withGrassCorner();
        l.spots = l.spots.filter((s) => s.kind !== 'desk');
        return l;
      })(),
      'not an object',
    ];
    for (const body of bad) {
      warnings.length = 0;
      await page.unroute(OVERRIDE);
      await page.route(OVERRIDE, (route) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }),
      );
      await page.reload();
      await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
      await expect(page.locator('#office .office-error')).toHaveCount(0);
      await expect.poll(() => corner(page)).toBe(bundledCorner);
      expect(warnings.join('\n')).toContain('Office layout override not used');
    }
    // server errors too
    await page.unroute(OVERRIDE);
    await page.route(OVERRIDE, (route) => route.fulfill({ status: 422, body: '{"error":"invalid json"}' }));
    await page.reload();
    await expect(canvas(page)).toHaveAttribute('data-agents', /\d+/);
    await expect(page.locator('#office .office-error')).toHaveCount(0);
    for (const p of problems.splice(0)) expect(p).toContain('status of 422');
  });

  test('an invalid bundled layout still shows the readable error, even with a bad override', async ({
    authedPage: page,
    problems,
  }) => {
    await page.route(OVERRIDE, (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 98 }) }),
    );
    await page.route('**/office/layout.json', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 99 }) }),
    );
    await page.reload();
    await expect(page.locator('#office .office-error')).toContainText('unsupported version 99');
    await expect(page.locator('#office canvas')).toHaveCount(0);
    expect(problems.splice(0).join('\n')).toContain('Invalid office layout');
  });
});

test.describe('abandoned runs', () => {
  const HOUR = 3600 * 1000;
  const ev = (run_id, meta, ts) => ({
    agent: 'orchestrator',
    type: 'pipeline',
    ts,
    meta: { run_id, repo: 'demo', ...meta },
  });
  const noMotion = (el) =>
    el.evaluate((n) => {
      const cs = getComputedStyle(n);
      return { anim: cs.animationName, pseudo: getComputedStyle(n, '::before').animationName };
    });

  test('a silent run and request show greyed with text and glyph; a new event revives them', async ({
    isolatedPage: page,
    isolatedServer: server,
  }) => {
    const old = Date.now() - 2 * HOUR;
    await server.emit(ev('ab-q', { kind: 'question', state: 'active', target: 'example-app' }, old));
    await server.emit(ev('ab-f', { step: 'verify', substep: 'test', state: 'active' }, old));
    const row = page.locator('#activity .act.s-abandoned');
    await expect(row).toContainText('⊘ ABANDONED / no updates for 120 min');
    await expect(row).not.toContainText('ACTIVE');
    const abPanel = page.locator('#pipeline [data-run-id="ab-f"]');
    const step = abPanel.locator('.stepper > li[data-step="verify"]');
    await expect(step).toHaveClass(/abandoned/);
    await expect(step.locator('.st')).toContainText('⊘ ABANDONED / no updates for 120 min');
    await expect(abPanel).toContainText('status: abandoned');
    await expect(step.locator('.substep[data-substep="test"]')).toContainText('ABANDONED');
    for (const el of [row, step, step.locator('.substep.abandoned')]) {
      const m = await noMotion(el);
      expect(m.anim).toBe('none');
      expect(m.pseudo).toBe('none');
    }
    // no header or card text counts it as running
    await expect(page.locator('#conn')).not.toContainText(/running|active/i);

    await server.emit(ev('ab-f', { step: 'verify', substep: 'test', state: 'active' }, Date.now()));
    await expect(step).not.toHaveClass(/abandoned/);
    await expect(step.locator('.st')).toContainText('ACTIVE');
    await expect(abPanel).toContainText('status: running');
    await server.emit(ev('ab-q', { kind: 'question', state: 'active' }, Date.now()));
    await expect(page.locator('#activity .act.s-abandoned')).toHaveCount(0);
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test('abandoned items do not scroll horizontally and stay static under reduced motion', async ({
      isolatedPage: page,
      isolatedServer: server,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const old = Date.now() - 3 * HOUR;
      await server.emit(ev('ab-pq', { kind: 'server_task', state: 'active', target: 'app-server' }, old));
      await server.emit(ev('ab-pf', { step: 'review', substep: 'security', state: 'active' }, old));
      await expect(page.locator('#activity .act.s-abandoned').first()).toContainText('ABANDONED');
      const abPhone = page.locator('#pipeline [data-run-id="ab-pf"] .stepper > li.abandoned');
      await expect(abPhone).toHaveCount(1);
      const m = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(m.s).toBeLessThanOrEqual(m.c);
      expect((await noMotion(abPhone)).pseudo).toBe('none');
    });
  });
});

test.describe('layout shell', () => {
  const SECTIONS = ['pipeline', 'agents', 'office', 'feed', 'costs', 'sessions', 'runs'];
  const metrics = (page) =>
    page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      mainW: document.querySelector('main').getBoundingClientRect().width,
      headerH: document.querySelector('header').getBoundingClientRect().height,
      officeH: document.querySelector('#office').getBoundingClientRect().height,
      pipelineH: document.querySelector('#sec-pipeline').getBoundingClientRect().height,
      stepperH: document.querySelector('#pipeline .stepper').getBoundingClientRect().height,
      tops: [...document.querySelectorAll('#pipeline [data-run-id="shell-steps"] .stepper > li')].map((l) =>
        Math.round(l.getBoundingClientRect().top),
      ),
    }));

  test('DOM order is header, pipeline, agents, office, feed, costs, sessions, runs', async ({
    authedPage: page,
  }) => {
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('body > header, main > section')].map((el) =>
        el.tagName === 'HEADER' ? 'header' : el.querySelector('button.sec-toggle').dataset.section,
      ),
    );
    expect(order).toEqual(['header', ...SECTIONS]);
    for (const id of SECTIONS) {
      const b = toggle(page, id);
      await expect(b).toHaveCount(1);
      expect(await b.evaluate((el) => el.parentElement.tagName)).toBe('H2');
      const body = await b.getAttribute('aria-controls');
      await expect(page.locator(`#${body}`)).toHaveCount(1);
    }
  });

  for (const [w, h] of [
    [1920, 1000],
    [1280, 900],
    [768, 900],
    [375, 800],
  ]) {
    // Isolated instance: the height limits below describe a single-run pipeline section.
    test(`${w}px: no horizontal page scroll, header and width limits`, async ({
      isolatedPage: page,
      isolatedServer: server,
    }) => {
      await server.emit({
        agent: 'orchestrator',
        type: 'pipeline',
        meta: { run_id: `shell-${w}`, step: 'spec', state: 'active', repo: 'demo', branch: 'feat/x' },
      });
      await page.setViewportSize({ width: w, height: h });
      await openSection(page, 'costs');
      await openSection(page, 'sessions');
      await expect(page.locator('#run-summary')).toContainText('Attempt');
      const m = await metrics(page);
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      if (w === 1920) expect(Math.round(m.mainW)).toBe(1440);
      if (w === 1280) {
        expect(m.headerH).toBeLessThanOrEqual(56);
        expect(m.officeH).toBeLessThanOrEqual(420);
        expect(m.pipelineH).toBeLessThanOrEqual(260);
      }
      if (w === 375) {
        expect(m.headerH).toBeLessThanOrEqual(96);
        expect(m.stepperH).toBeLessThanOrEqual(240);
      }
      if (w >= 1280) expect(m.officeH).toBeLessThanOrEqual(420);
    });
  }

  test('stepper: one row at 1280, 4+4 at 768, 2x4 at 375, labels in order', async ({
    authedPage: page,
    server,
  }) => {
    await server.emit({
      agent: 'orchestrator',
      type: 'pipeline',
      meta: { run_id: 'shell-steps', step: 'spec', state: 'passed', repo: 'demo', branch: 'b' },
    });
    const items = page.locator('#pipeline [data-run-id="shell-steps"] .stepper > li');
    await expect(items).toHaveCount(8);
    const labels = ['Spec', 'Code', 'Verify', 'Review', 'User approval', 'Merge', 'Deploy', 'Cleanup'];
    for (const [i, l] of labels.entries()) await expect(items.nth(i)).toContainText(l);
    const rows = async () => new Set((await metrics(page)).tops).size;
    expect(await rows()).toBe(1);
    await page.setViewportSize({ width: 768, height: 900 });
    expect(await rows()).toBe(2);
    await page.setViewportSize({ width: 375, height: 800 });
    const tops = (await metrics(page)).tops;
    expect(new Set(tops).size).toBe(4);
    expect(tops.filter((t) => t === tops[0])).toHaveLength(2);
  });

  test('chips stay inside their step and carry the state word', async ({ authedPage: page, server }) => {
    await server.emit({
      agent: 'orchestrator',
      type: 'pipeline',
      meta: { run_id: 'shell-chips', step: 'test', state: 'passed', repo: 'demo', branch: 'b' },
    });
    const chipEl = page.locator(
      '#pipeline [data-run-id="shell-chips"] .stepper > li[data-step="verify"] .substep[data-substep="test"]',
    );
    await expect(chipEl).toContainText('PASSED');
    await expect(chipEl).toHaveAttribute('aria-label', /Test: passed/);
  });

  test('sticky header stays at the top and the summary shows the run', async ({
    authedPage: page,
    server,
  }) => {
    await server.emit({
      agent: 'orchestrator',
      type: 'pipeline',
      meta: { run_id: 'shell-sum', step: 'spec', state: 'active', repo: 'demo-repo', branch: 'feat/sum' },
    });
    await expect(page.locator('#run-summary')).toContainText('demo-repo / feat/sum');
    await expect(page.locator('#run-summary')).toContainText('Attempt 1 of');
    expect(await page.locator('header').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
    await page.mouse.move(100, 400);
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    expect(await page.locator('header').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(0);
    await expect(page.locator('#conn')).toHaveAttribute('role', 'status');
    await expect(page.locator('#conn')).toHaveAttribute('aria-live', 'polite');
  });

  test('costs and sessions start collapsed, toggle, persist, keep the period select visible', async ({
    authedPage: page,
  }) => {
    for (const id of ['costs', 'sessions']) {
      await expect(toggle(page, id)).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(`#${id}`)).toBeHidden();
      await expect(page.locator(`#${id}`)).toHaveCount(1); // hidden, not removed
    }
    for (const id of ['pipeline', 'agents', 'office', 'feed', 'runs'])
      await expect(toggle(page, id)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#costs-days')).toBeVisible();
    await toggle(page, 'costs').click();
    await expect(toggle(page, 'costs')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#costs')).toBeVisible();
    await toggle(page, 'agents').click();
    await expect(page.locator('#agents')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('agent-dashboard.section.costs'))).toBe('open');
    expect(await page.evaluate(() => localStorage.getItem('agent-dashboard.section.agents'))).toBe('closed');
    await page.reload();
    await expect(toggle(page, 'costs')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(page, 'agents')).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page, 'sessions')).toHaveAttribute('aria-expanded', 'false');
    await toggle(page, 'costs').click();
    await expect(page.locator('#costs')).toBeHidden();
    await expect(page.locator('#costs-days')).toBeVisible();
  });

  test('a collapsed office keeps its zoom and refits when opened again', async ({ authedPage: page }) => {
    const c = page.locator('#office canvas.office-canvas');
    await expect(c).toHaveAttribute('data-agents', /\d+/);
    await toggle(page, 'office').click();
    await expect(page.locator('#office')).toBeHidden();
    await toggle(page, 'office').click();
    await expect(page.locator('#office')).toBeVisible();
    await expect.poll(async () => (await c.boundingBox()).height).toBeGreaterThan(300);
  });

  test('blocked localStorage falls back to the defaults and nothing breaks', async ({ page, server }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked');
        },
      });
    });
    await login(page, server.dashboardToken);
    await expect(toggle(page, 'costs')).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page, 'agents')).toHaveAttribute('aria-expanded', 'true');
    await toggle(page, 'costs').click();
    await expect(page.locator('#costs')).toBeVisible();
    await expect(page.locator('#office canvas')).toHaveAttribute('data-agents', /\d+/);
  });

  test('the office box is at most 420px tall and shows the whole scene at the default zoom', async ({
    authedPage: page,
  }) => {
    const c = page.locator('#office canvas.office-canvas');
    await expect(c).toHaveAttribute('data-agents', /\d+/);
    const o = await page.locator('#office').boundingBox();
    expect(o.height).toBeLessThanOrEqual(420);
    const cb = await c.boundingBox();
    expect(cb.height).toBeLessThanOrEqual(o.height);
    expect(cb.width).toBeLessThanOrEqual(o.width);
    await expect(c).toBeVisible();
  });
});

test.describe('panels (agent cards, feed, cost and session summaries)', () => {
  const usage = { 'claude-opus-5-5': { input: 1000, output: 500, cache_write_5m: 2000, cache_read: 40000 } };
  const money = (n) => `$${n.toFixed(4)}`;

  test('agent cards are at most 150px at 1280, details toggle and start closed', async ({
    authedPage: page,
    server,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await server.emit({ agent: 'code', type: 'status', task: 'Build the widget', summary: 'starting' });
    await server.emit({
      agent: 'verify',
      type: 'subagent_stop',
      summary: 'finished',
      tokens_in: 1500,
      tokens_out: 300,
    });
    await expect(card(page, 'code').locator('.badge')).toHaveText(/WORKING/);
    const heights = await page
      .locator('#agents article.card')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeLessThanOrEqual(150);
    const c = card(page, 'verify');
    const btn = c.getByRole('button', { name: /Details/ });
    const bodyId = await btn.getAttribute('aria-controls');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`#${bodyId}`)).toBeHidden();
    await expect(page.locator(`#${bodyId}`)).toContainText('Tokens in/out');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#${bodyId}`)).toBeVisible();
    await expect(c.locator('.badge')).toBeVisible();
    await expect(c.locator('.task')).toBeVisible();
    await expect(c.locator('canvas.avatar')).toHaveAttribute('aria-hidden', 'true');
    // not persisted: closed again after a reload
    await page.reload();
    await expect(card(page, 'verify').getByRole('button', { name: /Details/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('cost summary tiles stay visible while collapsed and match /api/costs; zero days fold', async ({
    authedPage: page,
    server,
  }) => {
    await server.emit({ agent: 'code', session_id: 'pan:a', type: 'subagent_stop', usage, repo: 'demo' });
    await expect(toggle(page, 'costs')).toHaveAttribute('aria-expanded', 'false');
    const api = await (await page.request.get('/api/costs?days=7')).json();
    const sum = page.locator('#costs-summary');
    await expect(sum).toBeVisible();
    await expect(sum).toContainText(money(api.today.cost_usd));
    await expect(sum.locator('.stat', { hasText: 'Today (UTC)' })).toBeVisible();
    await expect(sum.locator('.stat', { hasText: 'Last 7 days' })).toContainText(money(api.total.cost_usd));
    await expect(sum.locator('.stat', { hasText: 'Total' })).toHaveCount(0);
    await expect(sum).toContainText(api.pricing.version);
    await expect(page.locator('#costs')).toBeHidden();
    await page.locator('#costs-days').selectOption('30');
    await expect(sum.locator('.stat', { hasText: 'Last 30 days' })).toBeVisible();
    await openSection(page, 'costs');
    const day = page.locator('#costs').getByRole('table', { name: 'Cost by day (UTC)' });
    await expect(day.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('#costs')).toContainText(/\d+ days with no usage/);
    for (const name of ['Tokens by class', 'Cost by model', 'Cost by agent']) {
      await expect(page.locator('#costs').getByRole('table', { name })).toBeVisible();
    }
    await expect(page.locator('#costs .cost-table td.num').first()).toHaveCSS('white-space', 'nowrap');
    await page.locator('#costs-days').selectOption('7');
    await toggle(page, 'costs').click();
  });

  test('sessions summary shows the count and at most the latest 3', async ({ authedPage: page, server }) => {
    for (const n of ['s1', 's2', 's3', 's4']) {
      await server.emit({ agent: 'code', session_id: `sumsess-${n}`, type: 'subagent_stop', usage });
    }
    const api = await (await page.request.get('/api/sessions')).json();
    const sum = page.locator('#sessions-summary');
    await expect(toggle(page, 'sessions')).toHaveAttribute('aria-expanded', 'false');
    await expect(sum).toContainText(`${api.sessions.length} sessions`);
    await expect(sum.locator('.sess-row')).toHaveCount(3);
    await expect(sum).toContainText(`Showing latest 3 of ${api.sessions.length}`);
    await expect(page.locator('#sessions')).toBeHidden();
    await openSection(page, 'sessions');
    await expect(page.locator('#sessions tbody tr')).toHaveCount(api.sessions.length);
    await expect(page.locator('#sessions caption')).toHaveText('Cost per session, newest first');
    await toggle(page, 'sessions').click();
  });

  test('feed rows are one line with a title; the list is focusable', async ({ authedPage: page, server }) => {
    await server.emit({
      agent: 'code',
      type: 'tool_start',
      tool: 'Bash',
      summary: 'Bash: ' + 'long-summary-'.repeat(20),
    });
    await expect(feed(page).first()).toContainText('long-summary');
    await expect(page.locator('#feed')).toHaveAttribute('tabindex', '0');
    const row = feed(page).first();
    await expect(row.locator('.sum')).toHaveAttribute('title', /long-summary/);
    await expect(row.locator('.ty')).toHaveText('tool_start:Bash');
    const m = await page.evaluate(() => {
      const li = document.querySelector('#feed li');
      const sum = li.querySelector('.sum');
      return { h: li.getBoundingClientRect().height, clipped: sum.scrollWidth > sum.clientWidth };
    });
    expect(m.h).toBeLessThan(40);
    expect(m.clipped).toBe(true);
    await page.locator('#feed').focus();
    expect(await page.locator('#feed').evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none');
    expect((await page.locator('#feed').boundingBox()).height).toBeLessThanOrEqual(560);
  });

  test('keyboard focus is not hidden under the sticky header (scroll-padding-top)', async ({
    authedPage: page,
  }) => {
    const pad = await page.evaluate(() => ({
      pad: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
      head: document.querySelector('header').getBoundingClientRect().height,
    }));
    expect(pad.pad).toBeGreaterThan(pad.head);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#costs-days').focus();
    await page.keyboard.press('Shift+Tab');
    const top = await page
      .locator('button.sec-toggle[data-section="costs"]')
      .evaluate((e) => e.getBoundingClientRect().top);
    const head = await page.evaluate(() => document.querySelector('header').getBoundingClientRect().bottom);
    expect(top).toBeGreaterThanOrEqual(head);
  });

  for (const w of [1920, 1280, 768, 375]) {
    test(`${w}px: no horizontal scroll with costs and sessions expanded`, async ({ authedPage: page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await openSection(page, 'costs');
      await openSection(page, 'sessions');
      const m = await page.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      expect(m.s).toBeLessThanOrEqual(m.c);
      await toggle(page, 'costs').click();
      await toggle(page, 'sessions').click();
    });
  }
});
