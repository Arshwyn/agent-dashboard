'use strict';

const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Random hex is long enough (>=20), varied, and contains none of the placeholder words the
// server rejects ("token", "secret", ...), unlike a human-readable string.
const randomSecret = () => crypto.randomBytes(24).toString('hex');

async function waitHealthy(base, child, getLog) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited early (${child.exitCode}): ${getLog()}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`app did not become healthy: ${getLog()}`);
}

async function withServer(use, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dashboard-e2e-'));
  const port = await freePort();
  const ingestToken = randomSecret();
  const dashboardToken = randomSecret();
  let log = '';
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: path.join(dir, 'e2e.db'),
      INGEST_TOKEN: ingestToken,
      DASHBOARD_TOKEN: dashboardToken,
      COOKIE_SECURE: 'false',
      // role cards for standalone top-level sessions (the pipeline roles are played by people)
      AGENTS: 'spec,code,cleanup,server-ops,ask,verify,review',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(base, child, () => log.slice(-2000));
    await use({
      base,
      dashboardToken,
      ingestToken,
      async emit(event) {
        const res = await fetch(`${base}/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}` },
          body: JSON.stringify({ ts: Date.now(), session_id: `e2e-${event.agent}`, ...event }),
        });
        if (!res.ok) throw new Error(`POST /event -> ${res.status} ${await res.text()}`);
      },
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const test = base.extend({
  // One app instance per worker, always torn down (success or failure).
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => withServer(use),
    { scope: 'worker' },
  ],

  // A private app instance for one test, for tests that need an empty pipeline (the shared worker
  // instance accumulates runs from earlier tests, and the panel list is capped).
  // eslint-disable-next-line no-empty-pattern
  isolatedServer: async ({}, use) => withServer(use),

  // A private app instance with a short rest (8 s) and the default pool, for the named-people tests.
  // eslint-disable-next-line no-empty-pattern
  peopleServer: async ({}, use) => withServer(use, { AGENTS: 'orchestrator', AGENT_COOLDOWN_SECONDS: '8' }),

  // A private app instance whose orchestrator card carries a configured display label.
  labelServer: async ({}, use) =>
    // eslint-disable-line no-empty-pattern
    withServer(use, { AGENTS: 'orchestrator', AGENT_DISPLAY_NAMES: 'orchestrator=Example Bot' }),

  labelPage: async ({ browser, labelServer }, use) => {
    const context = await browser.newContext({ baseURL: labelServer.base });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await login(page, labelServer.dashboardToken);
    await use(page);
    await context.close();
    expect(problems, 'page errors').toEqual([]);
  },

  peoplePage: async ({ browser, peopleServer }, use) => {
    const context = await browser.newContext({ baseURL: peopleServer.base });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await login(page, peopleServer.dashboardToken);
    await use(page);
    await context.close();
    expect(problems, 'page errors').toEqual([]);
  },

  // A signed-in page on the isolated instance.
  isolatedPage: async ({ browser, isolatedServer }, use) => {
    const context = await browser.newContext({ baseURL: isolatedServer.base });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await login(page, isolatedServer.dashboardToken);
    await use(page);
    await context.close();
    expect(problems, 'page errors').toEqual([]);
  },

  baseURL: async ({ server }, use) => use(server.base),

  // Records console errors, uncaught page errors and CSP violations; each test asserts none occurred.
  problems: [
    async ({ page }, use) => {
      const problems = [];
      page.on('console', (m) => {
        // The office asks for the optional layout override first; when it is not configured the server
        // answers 404 and the browser logs that request. That is expected and not a problem.
        if (m.location().url.endsWith('/api/office-layout') && m.text().includes('status of 404')) return;
        if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      await use(problems);
      expect(problems, 'browser console errors / CSP violations').toEqual([]);
    },
    { auto: true },
  ],

  // A page that is already signed in through the real login form.
  authedPage: async ({ page, server }, use) => {
    await login(page, server.dashboardToken);
    await use(page);
  },
});

async function login(page, token) {
  await page.goto('/login');
  await page.getByLabel('Dashboard token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#conn')).toContainText('live');
}

module.exports = { test, expect, login };
