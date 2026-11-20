#!/usr/bin/env node
'use strict';
// Compatibility no-op. The orchestrator's Claude Code hooks still call this path; the dashboard no
// longer records pipeline activity, so this reads and discards stdin and exits 0 (fail-open).
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 1000).unref();
