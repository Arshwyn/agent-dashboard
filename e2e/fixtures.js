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

const test = base.extend({
  // One app instance per worker, always torn down (success or failure).
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
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
    },
    { scope: 'worker' },
  ],

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
