'use strict';

/**
 * Counts uncaught errors. One bug in one request should not take the server down, but a loop of errors means the
 * process is broken: past `max` errors inside `windowMs` it logs the error name and exits non-zero, so the
 * container's restart policy takes over. Only the error's name is ever logged.
 */
function createErrorGuard({
  max = 5,
  windowMs = 60_000,
  now = () => Date.now(),
  exit = (c) => process.exit(c),
  log = console.error,
} = {}) {
  const times = [];
  return function onError(kind, err) {
    const t = now();
    times.push(t);
    while (times.length && t - times[0] > windowMs) times.shift();
    log(`${kind}:`, err && err.name);
    if (times.length > max) {
      log('too many uncaught errors, exiting');
      exit(1);
    }
  };
}

module.exports = { createErrorGuard };
