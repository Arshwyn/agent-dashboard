'use strict';

// One log line per request: ISO time, method, route pattern, status, duration in ms, response bytes.
// Deliberately nothing else: no query string, headers, cookies, tokens, bodies, Access identity or client address.
// The path is reduced to a fixed pattern (`/api/chats/:id`), and anything that is not a known route is logged as
// `(other)`, so a secret or an odd string in a URL can never reach the log.

const EXACT = new Set([
  '/',
  '/event',
  '/roster.json',
  '/api/roster',
  '/api/me',
  '/api/chat/status',
  '/api/chats',
]);
const PATTERNS = [
  [/^\/agent\/[^/]+$/, '/agent/:id'],
  [/^\/api\/chats\/[^/]+$/, '/api/chats/:id'],
  [/^\/api\/chats\/[^/]+\/messages$/, '/api/chats/:id/messages'],
  [/^\/api\/chats\/[^/]+\/stop$/, '/api/chats/:id/stop'],
  [/^\/css\/[\w.-]+$/, '/css/:file'],
  [/^\/js\/[\w.-]+$/, '/js/:file'],
  [/^\/vendor\/[\w.-]+$/, '/vendor/:file'],
  [/^\/models\/[\w.-]+$/, '/models/:file'],
];

/** The pathname of a request target (never its query string), or '' when it is not a plain origin-form path. */
function pathOf(target) {
  const t = String(target || '');
  if (!t.startsWith('/') || t.startsWith('//') || t.includes('\\')) return '';
  const end = t.search(/[?#]/);
  return end < 0 ? t : t.slice(0, end);
}

function routePattern(target) {
  const p = pathOf(target);
  if (EXACT.has(p)) return p;
  for (const [re, name] of PATTERNS) if (re.test(p)) return name;
  return '(other)';
}

function isHealthCheck(target) {
  return pathOf(target) === '/healthz';
}

/** Returns `watch(req, res)`; it writes one line to `write` when the response is finished or the client is gone. */
function createRequestLogger(
  write,
  { clock = () => Date.now(), hrtime = () => process.hrtime.bigint() } = {},
) {
  return function watch(req, res) {
    if (isHealthCheck(req.url)) return; // a probe every few seconds would drown the log
    const t0 = hrtime();
    let bytes = 0;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const count = (chunk, enc) => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      bytes +=
        Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
          ? chunk.length
          : Buffer.byteLength(String(chunk), typeof enc === 'string' ? enc : 'utf8');
    };
    res.write = (chunk, enc, cb) => {
      count(chunk, enc);
      return origWrite(chunk, enc, cb);
    };
    res.end = (chunk, enc, cb) => {
      count(chunk, enc);
      return origEnd(chunk, enc, cb);
    };
    res.once('close', () => {
      // logging must never take the request, or the process, down: a failing sink or clock is ignored
      try {
        const ms = Number((hrtime() - t0) / 1_000_000n);
        const method = /^[A-Z]{1,10}$/.test(String(req.method)) ? req.method : 'OTHER';
        write(
          `${new Date(clock()).toISOString()} ${method} ${routePattern(req.url)} ${res.statusCode} ${ms}ms ${bytes}b`,
        );
      } catch {
        // dropped
      }
    });
  };
}

module.exports = { createRequestLogger, routePattern, isHealthCheck };
