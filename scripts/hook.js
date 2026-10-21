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
const { buildEvent, buildLinkEvent, loadEnvFile, curlConfig } = require('./lib/hook-lib');

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
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const events = [buildEvent(input, env)];
      try {
        events.push(buildLinkEvent(input, env)); // a link failure never blocks the main event
      } catch {
        /* fail open */
      }
      events.splice(0, events.length, ...events.filter(Boolean));
      if (!events.length) return done();
      const endpoint = url.replace(/\/+$/, '') + '/event';
      // One detached curl per event; exit once every config has been handed over.
      let pending = events.length;
      for (const ev of events) {
        let once = false;
        const sent = () => {
          if (once) return;
          once = true;
          pending -= 1;
          if (pending <= 0) done();
        };
        try {
          const cfg = curlConfig({ url: endpoint, token, body: JSON.stringify(ev) });
          const child = spawn('curl', ['-K', '-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
          child.on('error', sent);
          child.unref();
          child.stdin.on('error', sent);
          child.stdin.end(cfg, sent);
        } catch {
          sent();
        }
      }
    } catch {
      done();
    }
  });
  process.stdin.on('error', done);
} catch {
  done();
}
