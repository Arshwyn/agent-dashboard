'use strict';

const crypto = require('node:crypto');
const { GatewayError } = require('./gatewayClient');
const { createStreamMapper } = require('./streamMap');
const { cleanTitle } = require('./store');

const MESSAGE_MAX_CHARS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PILOT_AGENTS = Object.freeze(['arshwyn']);
// Gateway answers that mean nothing was started: the send is refused, so it leaves no rows behind.
const REFUSAL_CODES = new Set([
  'busy',
  'disabled',
  'not_enabled',
  'too_large',
  'unavailable',
  'spawn',
  'invalid',
]);

/**
 * The chat API. `h.json(res, status, body, headers)` sends JSON, `h.readJson(req, res, cb)` reads a size-capped JSON
 * body. All routes are behind Access and (for state changes) the CSRF check, both applied by the server first.
 */
function createChat({ config, store, gateway, now = () => Date.now(), keepaliveMs = 15_000 }, h) {
  const running = new Map(); // agent -> { runId, conversationId }
  const sendTimes = [];

  function rateWait() {
    const t = now();
    while (sendTimes.length && t - sendTimes[0] >= 60_000) sendTimes.shift();
    if (sendTimes.length >= config.chatMaxPerMin)
      return Math.max(1, Math.ceil((60_000 - (t - sendTimes[0])) / 1000));
    sendTimes.push(t);
    return 0;
  }

  const view = (c) => ({
    id: c.id,
    agent: c.agent,
    title: c.title,
    created_at: c.created_at,
    updated_at: c.updated_at,
    running: running.get(c.agent)?.conversationId === c.id,
  });
  const known = (id) => (typeof id === 'string' && UUID.test(id) ? store.getConversation(id) : null);

  async function status(res) {
    const out = {
      agents: [...PILOT_AGENTS],
      enabled: !config.chatDisabled,
      disabled_by: config.chatDisabled ? 'app' : null,
      available: false,
      busy: false,
    };
    if (!gateway) return h.json(res, 200, { ...out, enabled: false, available: false });
    try {
      const s = await gateway.status();
      out.available = true;
      out.busy = s.busy === true;
      if (s.enabled === false) {
        out.enabled = false;
        out.disabled_by = out.disabled_by || 'gateway';
      }
      out.agents = Array.isArray(s.agents) ? s.agents.filter((a) => PILOT_AGENTS.includes(a)) : [];
    } catch {
      out.available = false;
    }
    return h.json(res, 200, out);
  }

  function list(res, url) {
    const agent = url.searchParams.get('agent') || '';
    if (!PILOT_AGENTS.includes(agent)) return h.json(res, 200, { conversations: [] });
    return h.json(res, 200, { conversations: store.listConversations(agent).map(view) });
  }

  function create(req, res) {
    h.readJson(req, res, (body) => {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !['agent', 'title'].includes(k))
      ) {
        return h.json(res, 400, { error: 'bad request' });
      }
      if (typeof body.agent !== 'string' || !PILOT_AGENTS.includes(body.agent))
        return h.json(res, 409, { error: 'not_enabled' });
      const c = store.createConversation(
        body.agent,
        typeof body.title === 'string' && cleanTitle(body.title) ? body.title : 'New chat',
        now(),
      );
      return h.json(res, 201, { conversation: view(c) });
    });
  }

  function read(res, id) {
    const c = known(id);
    if (!c) return h.json(res, 404, { error: 'not found' });
    return h.json(res, 200, { conversation: view(c), messages: store.listMessages(c.id) });
  }

  function rename(req, res, id) {
    h.readJson(req, res, (body) => {
      const c = known(id);
      if (!c) return h.json(res, 404, { error: 'not found' });
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).join() !== 'title' ||
        typeof body.title !== 'string' ||
        !cleanTitle(body.title)
      ) {
        return h.json(res, 400, { error: 'bad request' });
      }
      store.renameConversation(c.id, body.title, now());
      return h.json(res, 200, { conversation: view(store.getConversation(c.id)) });
    });
  }

  function remove(res, id) {
    const c = known(id);
    if (!c) return h.json(res, 404, { error: 'not found' });
    if (running.get(c.agent)?.conversationId === c.id) return h.json(res, 409, { error: 'busy' });
    store.deleteConversation(c.id);
    return h.json(res, 200, { ok: true });
  }

  async function stop(res, id) {
    const c = known(id);
    const run = c && running.get(c.agent);
    if (!c || !run || run.conversationId !== c.id) return h.json(res, 404, { error: 'not running' });
    run.stopRequested = true;
    let ok = await gateway.cancel(run.runId);
    // the first attempt may have just ended: the flag then cancels the retry before it starts
    if (!ok && !run.retryDecided) ok = true;
    if (!ok) ok = await gateway.cancel(run.runId); // a retry started meanwhile has a new run id
    if (!ok) return h.json(res, 409, { error: 'nothing to cancel' });
    return h.json(res, 202, { ok: true });
  }

  function sendMessage(req, res, id) {
    h.readJson(req, res, (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'text') {
        return h.json(res, 400, { error: 'bad request' });
      }
      const text = body.text;
      if (typeof text !== 'string' || text.trim().length === 0 || text.includes('\0'))
        return h.json(res, 400, { error: 'bad request' });
      if (text.length > MESSAGE_MAX_CHARS) return h.json(res, 413, { error: 'message too long' });
      const c = known(id);
      if (!c) return h.json(res, 404, { error: 'not found' });
      if (!PILOT_AGENTS.includes(c.agent)) return h.json(res, 409, { error: 'not_enabled' });
      if (config.chatDisabled) return h.json(res, 503, { error: 'disabled' });
      if (!gateway) return h.json(res, 503, { error: 'unavailable' });
      if (running.has(c.agent)) return h.json(res, 409, { error: 'busy' });
      const wait = rateWait();
      if (wait) return h.json(res, 429, { error: 'rate limited' }, { 'Retry-After': String(wait) });
      return stream(req, res, c, text).catch(() => {});
    });
  }

  // One run of the gateway for this conversation. `resume` picks --resume or --session-id.
  async function attempt(c, text, resume, emit, entry) {
    const runId = crypto.randomBytes(18).toString('base64url');
    entry.runId = runId;
    // a Stop that was flagged before this run id existed could not name it; the gateway remembers an early cancel
    if (entry.stopRequested) gateway.cancel(runId).catch(() => {});
    const mapper = createStreamMapper();
    let result = null;
    let sawText = false;
    let sawTool = false;
    let exit = null;
    let gwError = null;
    let refused = false;
    try {
      exit = await gateway.run(
        { agent: c.agent, conversation_id: c.id, resume, prompt: text, run_id: runId },
        {
          onLine(line) {
            for (const ev of mapper.push(line)) {
              if (ev.kind === 'delta') {
                sawText = true;
                emit('delta', { text: ev.text });
              } else if (ev.kind === 'interim') emit('interim', { text: ev.text });
              else if (ev.kind === 'tool') {
                sawTool = true;
                emit('tool', { label: ev.label });
              } else if (ev.kind === 'result') result = ev;
            }
          },
        },
      );
    } catch (e) {
      gwError = e instanceof GatewayError ? e.code : 'unavailable';
      refused = e instanceof GatewayError && REFUSAL_CODES.has(e.code) && !sawText && !sawTool;
    }
    return { exit, result, gwError, refused, sawText, sawTool, mapper };
  }

  async function stream(req, res, c, text) {
    // one entry for the whole stream (both attempts): stop() flags it, so a stop that lands between a failed first
    // attempt and its retry cancels the retry instead of being lost
    const entry = { runId: '', conversationId: c.id, stopRequested: false, retryDecided: false };
    running.set(c.agent, entry);
    let gone = false;
    let started = false;
    let keepalive = null;
    let asstId = null;
    let userId;
    let renamed = false;
    const emit = (event, data) => {
      if (started && !gone) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      userId = store.addMessage(c.id, 'user', text, 'done', now());
      asstId = store.addMessage(c.id, 'assistant', '', 'streaming', now());
      if (store.listMessages(c.id).length === 2 && c.title === 'New chat')
        renamed = store.renameConversation(c.id, text.slice(0, 60), now());
      res.on('close', () => {
        gone = true;
      });
      res.writeHead(200, h.sseHeaders());
      started = true;
      emit('start', { message_id: asstId });
      emit('thinking', {});
      // A silent stretch (a long tool call) would let a proxy in front drop the idle stream; a comment line is
      // ignored by the browser and keeps it open.
      keepalive = setInterval(() => {
        if (!gone) res.write(': keepalive\n\n');
      }, keepaliveMs);

      // The session may exist or not, whatever the hub's flag says (a first run can die after the session was
      // created; a session file can be gone). A run that fails before it did anything (no tool event, no text) is
      // retried once in the other mode. A run that used a tool is NEVER retried: repeating the prompt could repeat
      // side effects (commands, writes, deploys). The flag is only set after a successful run; history is kept.
      let resume = c.session_started === true;
      let r = await attempt(c, text, resume, emit, entry);
      const failed = (x) =>
        !x.gwError &&
        !x.exit.cancelled &&
        !x.exit.timedOut &&
        !x.exit.tooBig &&
        !x.exit.switchedOff &&
        !x.sawText &&
        !x.sawTool &&
        ((x.result && x.result.isError) || x.exit.code !== 0);
      if (failed(r) && !gone) {
        if (entry.stopRequested) r.exit = { ...r.exit, cancelled: true };
        else {
          entry.retryDecided = true;
          resume = !resume;
          r = await attempt(c, text, resume, emit, entry);
        }
      }
      entry.retryDecided = true;
      const { exit, result, gwError, mapper } = r;

      // The gateway refused the run (busy, switched off, not reachable): nothing happened, so the send is taken
      // back completely. The browser shows a notice and puts the text back in the composer.
      if (r.refused) {
        const code = ['busy', 'disabled', 'not_enabled', 'too_large'].includes(gwError)
          ? gwError
          : 'unavailable';
        let undone = true;
        for (const id of [asstId, userId]) {
          try {
            store.deleteMessage(id);
          } catch {
            undone = false;
          }
        }
        if (undone) {
          if (renamed) store.renameConversation(c.id, 'New chat', now());
          asstId = null;
          emit('error', { code, refused: true });
          return;
        }
      }

      let statusName = 'done';
      let errorCode = null;
      if (gwError) {
        statusName = 'error';
        errorCode = ['busy', 'disabled', 'not_enabled', 'too_large'].includes(gwError)
          ? gwError
          : 'unavailable';
      } else if (exit.switchedOff) [statusName, errorCode] = ['error', 'switched_off'];
      else if (exit.cancelled) statusName = 'cancelled';
      else if (exit.timedOut) [statusName, errorCode] = ['error', 'timeout'];
      else if (exit.tooBig) [statusName, errorCode] = ['error', 'too_large'];
      else if ((result && result.isError) || exit.code !== 0) [statusName, errorCode] = ['error', 'failed'];
      // A store failure after the run must not drop the reply: the write is retried once, and if it still fails
      // the text is sent to the browser anyway, marked as not saved.
      const persist = (fn) => {
        for (let i = 0; i < 2; i++) {
          try {
            fn();
            return true;
          } catch {
            // try once more
          }
        }
        return false;
      };
      if (statusName === 'done' && result) persist(() => store.markSessionStarted(c.id));
      const finalText = mapper.finalText().trim() || (result && !result.isError ? result.text : '');
      const saved = persist(() =>
        store.updateMessage(asstId, { text: finalText, status: statusName, errorCode }),
      );
      // last resort: never leave the row 'streaming' (it would read as running until a restart); keep the text if possible
      if (!saved)
        persist(() => store.updateMessage(asstId, { text: finalText, status: 'error', errorCode: 'failed' }));
      const unsaved = saved ? {} : { unsaved: true };
      if (statusName === 'done') emit('done', { message_id: asstId, text: finalText, ...unsaved });
      else if (statusName === 'cancelled')
        emit('done', { message_id: asstId, text: finalText, cancelled: true, ...unsaved });
      else emit('error', { code: errorCode, message_id: asstId });
    } catch {
      // a store or stream failure: generic answer, and the slot is always released below
      if (!started) h.json(res, 500, { error: 'internal error' });
      else emit('error', { code: 'failed', message_id: asstId });
      try {
        if (asstId !== null) store.updateMessage(asstId, { text: '', status: 'error', errorCode: 'failed' });
      } catch {
        // the store is what failed; the next start marks it interrupted
      }
    } finally {
      clearInterval(keepalive);
      running.delete(c.agent);
      if (started && !gone) res.end();
    }
  }

  /** Called at startup: runs that were in flight when the app stopped can never finish. */
  function recover() {
    return store.markInterrupted();
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/chat/status' && m === 'GET') return status(res);
    if (p === '/api/chats') {
      if (m === 'GET') return list(res, url);
      if (m === 'POST') return create(req, res);
      return h.json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' });
    }
    const mt = /^\/api\/chats\/([^/]+)(?:\/(messages|stop))?$/.exec(p);
    if (!mt) return h.json(res, 404, { error: 'not found' });
    const [, id, sub] = mt;
    if (!sub) {
      if (m === 'GET') return read(res, id);
      if (m === 'PATCH') return rename(req, res, id);
      if (m === 'DELETE') return remove(res, id);
      return h.json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PATCH, DELETE' });
    }
    if (m !== 'POST') return h.json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    if (sub === 'messages') return sendMessage(req, res, id);
    return stop(res, id);
  }

  return { route, recover, running, MESSAGE_MAX_CHARS };
}

module.exports = { createChat, MESSAGE_MAX_CHARS, PILOT_AGENTS };
