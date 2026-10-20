#!/usr/bin/env node
'use strict';
// Claude Code hook -> agent-dashboard. FAIL-OPEN: always exits 0, never blocks the session.
// Config (env or ~/.config/agent-dashboard/hook.env):
//   AGENT_DASHBOARD_URL           e.g. http://<dashboard-host>:8787
//   AGENT_DASHBOARD_INGEST_TOKEN  the INGEST token only (cannot read any data)
//   AGENT_DASHBOARD_ROLE          optional role override for this process (spec, code, ...)
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildEvent, loadEnvFile, curlConfig } = require('./lib/hook-lib');

function done() {
  process.exit(0);
}
setTimeout(done, 1500).unref(); // hard stop no matter what

try {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const file =
        process.env.AGENT_DASHBOARD_ENV_FILE ||
        path.join(os.homedir(), '.config', 'agent-dashboard', 'hook.env');
      const env = { ...loadEnvFile(file), ...process.env };
      const url = env.AGENT_DASHBOARD_URL;
      const token = env.AGENT_DASHBOARD_INGEST_TOKEN;
      if (!url || !token) return done();
      const ev = buildEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')), env);
      if (!ev) return done();
      const cfg = curlConfig({ url: url.replace(/\/+$/, '') + '/event', token, body: JSON.stringify(ev) });
      const child = spawn('curl', ['-K', '-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      child.on('error', done);
      child.unref();
      child.stdin.on('error', done);
      child.stdin.end(cfg, done);
    } catch {
      done();
    }
  });
  process.stdin.on('error', done);
} catch {
  done();
}
