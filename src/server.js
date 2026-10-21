'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { safeEqual, bearer, parseCookies, FailureLimiter, SessionStore } = require('./auth');
const { validateEvent } = require('./schema');
const { AgentTracker, PipelineTracker, UNTRACKED_AGENTS } = require('./state');
const { DEFAULT_PRICING } = require('./pricing');
const { priceEvent, aggregateSessions, aggregateCosts } = require('./cost');
const { looksLikeLayout } = require('./layout-shape');
const { computeAssetVersion, strongEtag, etagMatches, safeRelPath } = require('./assets');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = 'ad_session';
const OFFICE_LAYOUT_MAX_BYTES = 512 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Keep authenticated responses out of the CDN edge (Cloudflare honours either header).
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};
const VERSIONED_PREFIX = /^\/v\/([0-9a-f]{12})(\/.*)$/;

function createApp(config, store, opts = {}) {
  const now = opts.now || (() => Date.now());
  const agents = new AgentTracker({
    doneToIdleSeconds: config.doneToIdleSeconds,
    staleMinutes: config.staleMinutes,
    configured: config.agents,
    maxAgents: config.maxAgents,
    names: config.agentNames,
    cooldownSeconds: config.agentCooldownSeconds,
    handoffWindowSeconds: config.handoffWindowSeconds,
    displayNames: config.agentDisplayNames,
  });
  const pipeline = new PipelineTracker({
    maxAttempts: config.maxAttempts,
    maxRuns: config.maxRuns,
    staleMinutes: config.pipelineStaleMinutes,
  });
  const sessions = new SessionStore({ ttlMs: config.sessionHours * 3600 * 1000, now });
  const loginLimiter = new FailureLimiter({ max: 5, windowMs: 5 * 60 * 1000, now });
  const ingestLimiter = new FailureLimiter({ max: 30, windowMs: 60 * 1000, now });
  const ingestRate = new FailureLimiter({ max: config.ingestRatePerMin, windowMs: 60 * 1000, now });
  const clients = new Set();
  const clientSession = new Map(); // SSE response -> session hash (null for bearer-authed)
  const lastSent = new Map();
  const pricing = opts.pricing || config.pricing || DEFAULT_PRICING;
  const unknownModels = new Set();
  function noteUnknownModel(m) {
    if (unknownModels.has(m) || unknownModels.size >= 100) return;
    unknownModels.add(m);
    console.warn(`WARNING: no pricing for model id "${m}"; its usage is shown as unpriced`);
  }

  // Rebuild derived state from stored events (last 48h of activity, last 7d of pipeline).
  function rebuild() {
    const t = now();
    for (const ev of store.eventsFromTs(t - 48 * 3600 * 1000)) agents.apply(ev);
    agents.retire(t);
    for (const ev of store.usageEventsFrom(t - config.retentionDays * 86400 * 1000)) {
      for (const [m, c] of Object.entries(ev.usage || {})) if (c.cost_usd === null) noteUnknownModel(m);
    }
    for (const ev of store.eventsFromTs(t - 7 * 86400 * 1000, ['pipeline'])) pipeline.apply(ev);
    for (const v of agents.snapshot(t)) lastSent.set(v.id, JSON.stringify(v));
  }
  rebuild();

  // Static assets are served under /v/<hash>/ (immutable); index.html is rewritten once here.
  const assetVersion = computeAssetVersion(PUBLIC_DIR);
  const vpath = (p) => `/v/${assetVersion}${p}`;
  let indexHtml = null;
  try {
    indexHtml = fs
      .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replaceAll('"/css/app.css"', `"${vpath('/css/app.css')}"`)
      .replaceAll('"/js/main.js"', `"${vpath('/js/main.js')}"`);
  } catch {
    indexHtml = null;
  }

  // ------------------------------------------------------------ helpers
  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',').pop().trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  const hsts = config.cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {};

  function send(res, status, body, headers = {}) {
    const isObj = typeof body === 'object' && body !== null;
    const payload = isObj ? JSON.stringify(body) : String(body ?? '');
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...hsts,
      'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  function hasSession(req) {
    return sessions.valid(parseCookies(req.headers.cookie)[COOKIE]);
  }

  // Bearer comparison is only attempted when the client is not currently throttled, so a
  // correct guess cannot succeed while the limiter is blocking.
  function bearerOk(req, ip) {
    if (loginLimiter.blockedFor(ip)) return false;
    const b = bearer(req);
    return b !== null && safeEqual(b, config.dashboardToken);
  }

  function readBody(req, res, cb) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > config.maxBodyBytes) {
        aborted = true;
        send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) cb(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {});
  }

  // ------------------------------------------------------------ SSE
  function sseWrite(res, event, data, id) {
    let msg = '';
    if (id !== undefined) msg += `id: ${id}\n`;
    msg += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(msg);
  }

  function broadcast(event, data, id) {
    for (const c of clients) sseWrite(c, event, data, id);
  }

  // Abandonment is clock-driven, so pipeline changes are diffed and pushed on a timer too.
  let lastPipeline = null;
  function broadcastPipelineChanges() {
    const snap = pipeline.snapshot(now());
    const json = JSON.stringify(snap);
    if (json === lastPipeline) return;
    lastPipeline = json;
    broadcast('pipeline', snap);
  }

  function broadcastAgentChanges() {
    const t = now();
    const gone = agents.retire(t);
    if (gone.length) {
      for (const id of gone) lastSent.delete(id);
      broadcast('resync', { reason: 'extra worker left' }); // clients reload the card list
    }
    for (const v of agents.snapshot(t)) {
      const json = JSON.stringify(v);
      if (lastSent.get(v.id) !== json) {
        lastSent.set(v.id, json);
        broadcast('agent', v);
      }
    }
  }

  function handleStream(req, res) {
    if (clients.size >= config.maxSseClients) return send(res, 503, { error: 'too many streams' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...hsts,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const lastId = Number.parseInt(req.headers['last-event-id'], 10);
    if (Number.isFinite(lastId) && lastId >= 0) {
      const missed = store.eventsSince(lastId, 501);
      if (missed.length > 500) sseWrite(res, 'resync', { reason: 'too many missed events' });
      else for (const ev of missed) sseWrite(res, 'event', ev, ev.id);
    }
    for (const v of agents.snapshot(now())) sseWrite(res, 'agent', v);
    sseWrite(res, 'pipeline', pipeline.snapshot(now()));
    clients.add(res);
    // Bind to a session only when the cookie is what authenticated this request; a bearer
    // client that also carries a stale/garbage cookie must not be closed by session expiry.
    clientSession.set(res, hasSession(req) ? sessions.hash(parseCookies(req.headers.cookie)[COOKIE]) : null);
    req.on('close', () => {
      clients.delete(res);
      clientSession.delete(res);
    });
  }

  // ------------------------------------------------------------ routes
  function handleIngest(req, res) {
    const ip = clientIp(req);
    const wait = ingestLimiter.blockedFor(ip);
    if (wait) return send(res, 429, { error: 'too many failed attempts' }, { 'Retry-After': String(wait) });
    const tok = bearer(req);
    if (tok === null || !safeEqual(tok, config.ingestToken)) {
      ingestLimiter.fail(ip);
      return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    // Throttle successful ingest per client too.
    const rateWait = ingestRate.blockedFor(ip);
    if (rateWait) return send(res, 429, { error: 'rate limited' }, { 'Retry-After': String(rateWait) });
    ingestRate.fail(ip);
    readBody(req, res, (text) => {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      const result = validateEvent(body, now());
      if (!result.ok) return send(res, 400, { error: 'invalid event', details: result.errors });
      const ev = result.event;
      // The person is chosen here, never taken from the client (validateEvent drops unknown fields).
      ev.instance = agents.assign(ev, now());
      // A subagent event with no person left (past the cap of 99), or a top-level event named after a
      // pool person or overflow id, is stored but gets no card.
      const noCard = ev.type !== 'pipeline' && agents.noCard(ev);
      if (ev.type !== 'pipeline' && !noCard && !agents.canTrack(ev.agent, ev.instance)) {
        return send(res, 422, { error: 'too many distinct agents' });
      }
      let row;
      try {
        priceEvent(ev, { store, pricing, onUnknownModel: noteUnknownModel });
        row = store.insertEvent(ev);
      } catch (e) {
        console.error('insert failed:', e.code || e.name);
        return send(res, 500, { error: 'storage error' });
      }
      agents.apply(row);
      pipeline.apply(row);
      broadcast('event', row, row.id);
      if (row.type === 'pipeline') {
        const snap = pipeline.snapshot(now());
        lastPipeline = JSON.stringify(snap);
        broadcast('pipeline', snap);
      } else if (!UNTRACKED_AGENTS.includes(row.agent) && !noCard) {
        const card = agents.cardFor(row);
        if (card) {
          const v = agents.view(card, now());
          lastSent.set(v.id, JSON.stringify(v));
          broadcast('agent', v);
        }
        broadcastAgentChanges(); // e.g. the giver of a handoff
      }
      send(res, 201, { ok: true, id: row.id });
    });
  }

  function loginPage(error) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Dashboard - sign in</title><link rel="stylesheet" href="${vpath('/css/app.css')}"></head>
<body class="login"><main class="login-card"><h1>Mission Control</h1>
<form method="post" action="/login">
<label for="token">Dashboard token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
${error ? `<p class="error" role="alert">${error}</p>` : ''}
<button type="submit">Sign in</button></form></main></body></html>`;
  }

  function handleLogin(req, res) {
    const ip = clientIp(req);
    const wait = loginLimiter.blockedFor(ip);
    if (wait) {
      return send(res, 429, loginPage('Too many attempts. Try again later.'), {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': String(wait),
      });
    }
    readBody(req, res, (text) => {
      let token = '';
      const ct = req.headers['content-type'] || '';
      try {
        if (ct.includes('application/json')) token = String(JSON.parse(text).token ?? '');
        else token = new URLSearchParams(text).get('token') || '';
      } catch {
        token = '';
      }
      if (!token || !safeEqual(token, config.dashboardToken)) {
        loginLimiter.fail(ip);
        return send(res, 401, loginPage('Invalid token.'), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      loginLimiter.reset(ip);
      const id = sessions.create();
      const cookie = [
        `${COOKIE}=${id}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${config.sessionHours * 3600}`,
        ...(config.cookieSecure ? ['Secure'] : []),
      ].join('; ');
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        ...hsts,
        Location: '/',
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store',
      });
      res.end();
    });
  }

  function endStreams(sid) {
    for (const [c, s] of clientSession) {
      if (s === sid) c.end();
    }
  }

  function handleLogout(req, res) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const sid = sessions.hash(id);
    sessions.destroy(id);
    if (sid) endStreams(sid);
    res.writeHead(303, {
      ...SECURITY_HEADERS,
      ...hsts,
      Location: '/login',
      'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
    res.end();
  }

  // The optional office layout override. The path comes only from the OFFICE_LAYOUT_PATH env var (no
  // request input), the file is re-read on every request and no error ever names the path or the
  // parser's message. Any I/O problem is reported as a plain 404.
  async function handleOfficeLayout(res) {
    const file = config.officeLayoutPath;
    if (!file) return send(res, 404, { error: 'not found' });
    let handle = null;
    try {
      // O_NONBLOCK so opening a FIFO cannot block; the fstat on the open handle (no separate stat,
      // so no check/open race) rejects anything that is not a regular file.
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) return send(res, 404, { error: 'not found' });
      if (stat.size > OFFICE_LAYOUT_MAX_BYTES) return send(res, 413, { error: 'layout too large' });
      // Capped at MAX + 1 so a file that grows after the fstat still yields 413, never a bigger buffer.
      const buf = Buffer.alloc(Math.max(1, Math.min(stat.size, OFFICE_LAYOUT_MAX_BYTES) + 1));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > OFFICE_LAYOUT_MAX_BYTES) return send(res, 413, { error: 'layout too large' });
      let layout;
      try {
        layout = JSON.parse(buf.toString('utf8', 0, bytesRead));
      } catch {
        return send(res, 422, { error: 'invalid json' });
      }
      if (!looksLikeLayout(layout)) return send(res, 422, { error: 'invalid json' });
      let body;
      try {
        body = JSON.stringify(layout);
      } catch {
        return send(res, 422, { error: 'invalid json' });
      }
      return send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch {
      return send(res, 404, { error: 'not found' });
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function handleApi(req, res, url) {
    const p = url.pathname;
    if (p === '/api/office-layout') {
      handleOfficeLayout(res).catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
        else res.end();
      });
      return;
    }
    if (p === '/api/agents')
      return send(res, 200, {
        agents: agents.snapshot(now()),
        display_names: config.agentDisplayNames,
        now: now(),
      });
    if (p === '/api/pipeline') return send(res, 200, pipeline.snapshot(now()));
    if (p === '/api/events') {
      const q = url.searchParams;
      let limit = Number.parseInt(q.get('limit') ?? '50', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      limit = Math.min(limit, 200);
      const beforeRaw = q.get('before');
      const before = beforeRaw === null ? null : Number.parseInt(beforeRaw, 10);
      if (beforeRaw !== null && (!Number.isFinite(before) || before < 1)) {
        return send(res, 400, { error: 'before must be a positive event id' });
      }
      const agent = q.get('agent') || null;
      if (agent && !/^[A-Za-z0-9._:@/-]{1,40}$/.test(agent)) return send(res, 400, { error: 'bad agent' });
      const instance = q.get('instance') || null;
      if (instance && !/^[A-Za-z0-9._:@/-]{1,43}$/.test(instance)) {
        return send(res, 400, { error: 'bad instance' });
      }
      const events = store.listEvents({ limit, before, agent, instance });
      const next = events.length === limit ? events[events.length - 1].id : null;
      return send(res, 200, { events, next_before: next });
    }
    if (p === '/api/sessions') {
      let limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      limit = Math.min(limit, 200);
      const rows = store.usageEventsFrom(now() - config.retentionDays * 86400 * 1000);
      return send(res, 200, {
        sessions: aggregateSessions(rows, { limit }),
        pricing: { version: pricing.version, as_of: pricing.as_of },
        now: now(),
      });
    }
    if (p === '/api/costs') {
      let days = Number.parseInt(url.searchParams.get('days') ?? '7', 10);
      if (!Number.isFinite(days) || days < 1) days = 7;
      days = Math.min(days, config.retentionDays);
      const t = now();
      const rows = store.usageEventsFrom(Math.floor(t / 86400000) * 86400000 - (days - 1) * 86400000);
      return send(
        res,
        200,
        aggregateCosts(rows, { days, now: t, retentionDays: config.retentionDays, pricing, unknownModels }),
      );
    }
    if (p === '/api/stream') return handleStream(req, res);
    return send(res, 404, { error: 'not found' });
  }

  function staticHeaders(cacheControl, type, etag) {
    return {
      ...SECURITY_HEADERS,
      ...hsts,
      'Content-Type': type,
      'Cache-Control': cacheControl,
      ...(etag ? { ETag: etag } : {}),
    };
  }

  function sendIndex(res) {
    if (indexHtml === null) return send(res, 404, 'not found');
    res.writeHead(200, staticHeaders('no-store', MIME['.html']));
    res.end(indexHtml);
  }

  // `versioned` = served from /v/<current hash>/: immutable. Otherwise legacy: revalidate.
  function serveStatic(req, res, rel, versioned) {
    if (!safeRelPath(rel.slice(1))) return send(res, 404, 'not found');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      const etag = strongEtag(data);
      const cc = versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache';
      const headers = staticHeaders(cc, MIME[path.extname(file)] || 'application/octet-stream', etag);
      if (etagMatches(req.headers['if-none-match'], etag)) {
        delete headers['Content-Type'];
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  // Returns the file path under public/ for /v/<current version>/..., or null.
  function versionedRel(p) {
    const mt = VERSIONED_PREFIX.exec(p);
    return mt && mt[1] === assetVersion ? mt[2] : null;
  }

  function route404(res) {
    return send(res, 404, 'not found');
  }

  function handleStatic(req, res, p) {
    if (p === '/' || p === '/index.html') return sendIndex(res);
    if (p.startsWith('/v/')) {
      const rel = versionedRel(p);
      return rel === null ? route404(res) : serveStatic(req, res, rel, true);
    }
    return serveStatic(req, res, p, false);
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const m = req.method;

      if (p === '/healthz' && (m === 'GET' || m === 'HEAD')) return send(res, 200, 'ok');
      if (p === '/event') {
        if (m !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
        return handleIngest(req, res);
      }
      if (p === '/login') {
        if (m === 'GET') {
          return send(res, 200, loginPage(''), { 'Content-Type': 'text/html; charset=utf-8' });
        }
        if (m === 'POST') return handleLogin(req, res);
        return send(res, 405, { error: 'method not allowed' });
      }
      if ((p === '/css/app.css' || p === vpath('/css/app.css')) && m === 'GET')
        return handleStatic(req, res, p);

      // Everything below requires dashboard auth (ingest token never grants read access).
      const ip = clientIp(req);
      if (!hasSession(req) && !bearerOk(req, ip)) {
        const wait = loginLimiter.blockedFor(ip);
        if (!wait && bearer(req) !== null) loginLimiter.fail(ip);
        if (p.startsWith('/api/')) {
          return send(res, wait ? 429 : 401, { error: wait ? 'too many failed attempts' : 'unauthorized' });
        }
        res.writeHead(302, { ...SECURITY_HEADERS, Location: '/login', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (p === '/logout' && m === 'POST') return handleLogout(req, res);
      if (m !== 'GET' && m !== 'HEAD') {
        const allow = p.startsWith('/api/') ? { Allow: 'GET, HEAD' } : {};
        return send(res, 405, { error: 'method not allowed' }, allow);
      }
      if (p.startsWith('/api/')) return handleApi(req, res, url);
      return handleStatic(req, res, p);
    } catch (e) {
      console.error('request error:', e.name);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;

  const timers = [];
  timers.push(setInterval(broadcastAgentChanges, 5000));
  timers.push(setInterval(broadcastPipelineChanges, 5000));
  timers.push(
    setInterval(() => {
      for (const c of clients) {
        const sid = clientSession.get(c);
        if (sid && !sessions.validHash(sid))
          c.end(); // session expired
        else c.write(': heartbeat\n\n');
      }
    }, 20000),
  );
  timers.push(setInterval(() => sessions.sweep(), 10 * 60 * 1000));
  timers.push(
    setInterval(
      () => {
        try {
          store.prune({ retentionDays: config.retentionDays, maxRows: config.maxRows });
        } catch (e) {
          console.error('prune failed:', e.name);
        }
      },
      config.pruneIntervalMinutes * 60 * 1000,
    ),
  );
  for (const t of timers) t.unref();

  function close() {
    for (const t of timers) clearInterval(t);
    for (const c of clients) c.end();
    clients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    server,
    close,
    agents,
    pipeline,
    broadcastAgentChanges,
    broadcastPipelineChanges,
    clients,
    clientSession,
    assetVersion,
  };
}

module.exports = { createApp };
