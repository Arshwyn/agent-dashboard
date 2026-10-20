'use strict';

const { defineConfig } = require('@playwright/test');

// The app under test is started per worker by the fixture in e2e/fixtures.js
// (free port, scratch DB, random tokens), so there is no webServer block here.
module.exports = defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
