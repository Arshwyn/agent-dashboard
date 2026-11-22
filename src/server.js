'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AccessVerifier } = require('./access');
const { csrfOk, jsonContentType } = require('./csrf');
const { createChat } = require('./chat');
const { createRequestLogger } = require('./requestLog');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
const BASE_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};
// The page may frame exactly one origin, and only when the Apollo embed is on; otherwise the policy is the
// strict default (frame-src falls back to default-src 'none'). Framing of the hub itself stays refused.
function securityHeaders(config) {
  if (!config.apolloEmbed || !config.apolloOrigin) return BASE_SECURITY_HEADERS;
  const csp = BASE_SECURITY_HEADERS['Content-Security-Policy'].replace(
    "connect-src 'self';",
    `connect-src 'self'; frame-src ${config.apolloOrigin};`,
  );
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': csp };
}

const ROSTER = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'roster.json'), 'utf8')).agents;
const AGENT_IDS = new Set(ROSTER.map((a) => a.id));
const STATIC_OK = /^\/(roster\.json|css\/[\w.-]+|js\/[\w.-]+|vendor\/[\w.-]+|models\/[\w.-]+)$/;

function createApp(config, opts = {}) {
  const verifier = config.devBypass
    ? null
    : new AccessVerifier({
        teamDomain: config.accessTeamDomain,
        aud: config.accessAud,
        ownerEmail: config.ownerEmail,
        fetchJson: opts.fetchJson,
        now: opts.now,
      });
  const SECURITY_HEADERS = securityHeaders(config);
  const hsts = config.production ? { 'Strict-Transport-Security': 'max-age=31536000' } : {};

  function send(res, status, body, headers = {}) {
    const isObj = typeof body === 'object' && body !== null;
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...hsts,
      'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : String(body ?? ''));
  }

  // The dev bypass trusts only a loopback peer, on top of the config rule that it needs a loopback host.
  function isLoopbackPeer(req) {
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  // A request that came through a proxy or tunnel (forwarding or Cloudflare headers) is never a local one.
  function proxied(req) {
    return Object.keys(req.headers).some(
      (h) => h === 'x-forwarded-for' || h === 'forwarded' || h.startsWith('cf-'),
    );
  }

  async function authenticate(req) {
    if (config.devBypass) {
      return isLoopbackPeer(req) && !proxied(req)
        ? { ok: true, email: 'dev@localhost.invalid' }
        : { ok: false, status: 403, reason: 'bypass is local only' };
    }
    const h = req.headers['cf-access-jwt-assertion'];
    return verifier.verify(Array.isArray(h) ? h[0] : h);
  }

  // /event is a stub that keeps hooks configured elsewhere from erroring: it drains the body and stores nothing.
  function handleEventStub(req, res) {
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) req.destroy();
    });
    req.on('end', () => {
      res.writeHead(204, { ...SECURITY_HEADERS, ...hsts, 'Cache-Control': 'no-store' });
      res.end();
    });
    req.on('error', () => {});
  }

  // Chat API plumbing. Bodies are JSON only and capped well below the stub's limit.
  const MAX_JSON_BYTES = 20 * 1024;
  function readJson(req, res, cb) {
    if (!jsonContentType(req)) return send(res, 415, { error: 'content type must be application/json' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES)
      return send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        dead = true;
        send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      try {
        cb(body);
      } catch {
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
        else res.end();
      }
    });
    req.on('error', () => {});
  }
  const chat = createChat(
    { config, store: opts.store, gateway: opts.gateway, now: opts.now, keepaliveMs: opts.keepaliveMs },
    {
      json: send,
      readJson,
      sseHeaders: () => ({
        ...SECURITY_HEADERS,
        ...hsts,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }),
    },
  );
  if (opts.store) chat.recover();

  function roster() {
    return ROSTER.map((a) => ({
      ...a,
      link: a.chat === 'link' && config.apolloChatUrl ? config.apolloChatUrl : null,
      ...(a.chat === 'link' && config.apolloChatUrl && config.apolloEmbed ? { embed: true } : {}),
    }));
  }

  function sendFile(req, res, file, type) {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      const etag = `"${crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)}"`;
      const headers = {
        ...SECURITY_HEADERS,
        ...hsts,
        'Content-Type': type,
        'Cache-Control': 'private, no-cache',
        ETag: etag,
      };
      if (req.headers['if-none-match'] === etag) {
        delete headers['Content-Type'];
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  function handleStatic(req, res, p) {
    if (p === '/' || p.startsWith('/agent/')) {
      if (p !== '/' && !AGENT_IDS.has(p.slice('/agent/'.length))) return send(res, 404, 'not found');
      return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), MIME['.html']);
    }
    if (!STATIC_OK.test(p)) return send(res, 404, 'not found');
    const file = path.join(PUBLIC_DIR, p);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'not found');
    return sendFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream');
  }

  const watch = opts.requestLog ? createRequestLogger(opts.requestLog, { clock: opts.now }) : null;
  const server = http.createServer((req, res) => {
    if (watch) watch(req, res);
    (async () => {
      // The path comes from the request target only when it is a plain origin-form path: a target such as
      // //host/path or one with a backslash would otherwise be read as another host by the URL parser.
      const target = String(req.url || '');
      const badTarget = !target.startsWith('/') || target.startsWith('//') || target.includes('\\');
      const p = badTarget ? '' : new URL(target, 'http://localhost').pathname;
      const m = req.method;
      if (p === '/healthz' && (m === 'GET' || m === 'HEAD')) return send(res, 200, 'ok');
      if (p === '/event') {
        if (m !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
        return handleEventStub(req, res);
      }
      const auth = await authenticate(req);
      if (!auth.ok) {
        const msg = auth.status === 401 ? 'unauthorized' : auth.status === 403 ? 'forbidden' : 'unavailable';
        return send(res, auth.status, { error: msg });
      }
      if (badTarget) return send(res, 400, { error: 'bad request target' });
      if (m !== 'GET' && m !== 'HEAD' && !csrfOk(req)) return send(res, 403, { error: 'forbidden' });
      if (p === '/api/chat/status' || p === '/api/chats' || p.startsWith('/api/chats/')) {
        if (!opts.store) return send(res, 503, { error: 'unavailable' });
        return chat.route(req, res, new URL(target, 'http://localhost'));
      }
      if (m !== 'GET' && m !== 'HEAD')
        return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      if (p === '/api/roster') return send(res, 200, { agents: roster() });
      if (p === '/api/me') return send(res, 200, { email: auth.email });
      if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      return handleStatic(req, res, p);
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;

  function close() {
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  return { server, close, chat };
}

module.exports = { createApp };
