#!/usr/bin/env node
'use strict';
// Host-side chat gateway for the agent hub. It launches `claude -p` for the hub container over its own unix socket.
//
// Dependency-free (node: built-ins only, Node 20 compatible). The hub sends only
//   { agent, conversation_id, resume, prompt, run_id }
// and this script builds the argv, the environment and the working directory itself from a fixed profile table,
// validates every field, and never logs prompts, replies or tool inputs. The browser never reaches this process.
//
// Protocol: newline-delimited JSON, one request per connection.
//   run:    {"agent":"arshwyn","conversation_id":"<uuid>","resume":false,"prompt":"...","run_id":"..."}
//   cancel: {"cancel":"<run_id>"}
//   status: {"op":"status"}  -> {"type":"status","enabled":true,"busy":false,"agents":["arshwyn"]}
// Responses: {"type":"line","data":"<raw stream-json line>"} ..., then
//   {"type":"exit","code":0,"signal":null,"timedOut":false,"cancelled":false,"switchedOff":false,"outBytes":123}
//   or {"type":"error","code":"invalid|not_enabled|not_proxied|disabled|busy|too_large|spawn"} (generic codes only).
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AGENT_ID = /^[a-z][a-z0-9_]{1,19}$/;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 16000;
// Permission modes a profile may use. `bypassPermissions` (and the dangerous-skip flags) are never allowed.
const ALLOWED_PERMISSION_MODES = Object.freeze(['default', 'auto', 'dontAsk']);
const PRECANCEL_TTL_MS = 15_000;
const PRECANCEL_MAX = 32;
const REQUEST_KEYS = new Set(['agent', 'conversation_id', 'resume', 'prompt', 'run_id']);

// The profile table is the safety control. Each enabled profile is a fixed command line: the browser, the hub and
// the request can choose none of it. `arshwyn` is the orchestrator's MAIN session (no --agent flag): the working
// directory is the orchestrator workspace, so the workspace's own CLAUDE.md, settings, permission rules and hooks
// apply exactly as in an interactive session. The permission mode is `auto` (the classifier-based mode the
// interactive session uses): the classifier reviews each action, and anything that would still fall back to a prompt
// is denied because --permission-prompts none leaves nobody to approve it. No permission-bypass flag appears
// anywhere (assertSafeArgv refuses one), and no --allowedTools.
// The seven other hub agents run as `claude --agent <id>`: Claude Code applies the agent file's tool list and model
// to the main session (sub-agents page, "Run the whole session as a subagent"), and the same workspace settings,
// rules and hooks apply. The profile never passes `--tools` or `--allowedTools`; the tool list stays in the agent
// file, and the drift check (checkAgentFile) refuses a run when that file no longer matches the table below.
// `apollo` is deliberately absent (it has its own chat app and its own health-data isolation, and is never proxied
// here); Mercury is not in the table.
const SETTING_SOURCES = Object.freeze(['user', 'project', 'local']);
const THEMIS_TOOLS = [
  'Bash',
  'Read',
  'Grep',
  'Glob',
  ...[
    'navigate',
    'navigate_back',
    'snapshot',
    'take_screenshot',
    'resize',
    'click',
    'hover',
    'type',
    'fill_form',
    'press_key',
    'select_option',
    'wait_for',
    'console_messages',
    'network_requests',
    'emulate_media',
    'find',
    'tabs',
    'handle_dialog',
    'close',
  ].map((t) => `mcp__plugin_playwright_playwright__browser_${t}`),
];
/** `expectedTools: null` means the agent file has no `tools` line, so the agent inherits every tool of the session. */
function agentProfile(id, expectedTools) {
  return Object.freeze({
    enabled: true,
    kind: 'agent',
    agent: id,
    name: `agent-${id}`,
    maxTurns: 40,
    permissionMode: 'auto',
    settingSources: SETTING_SOURCES,
    expectedTools: expectedTools === null ? null : Object.freeze([...expectedTools]),
  });
}
const PROFILES = Object.freeze({
  arshwyn: Object.freeze({
    enabled: true,
    kind: 'main',
    name: 'main-session',
    maxTurns: 40,
    permissionMode: 'auto',
    settingSources: SETTING_SOURCES,
  }),
  hephaestus: agentProfile('hephaestus', null),
  themis: agentProfile('themis', THEMIS_TOOLS),
  janus: agentProfile('janus', ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch']),
  atlas: agentProfile('atlas', ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch']),
  plutus: agentProfile('plutus', null),
  iris: agentProfile('iris', null),
  dionysus: agentProfile('dionysus', null),
});

/** HUB_DENY_TOOLS: comma-separated tool deny patterns from the operator's environment (connector names stay out of the repo). */
function parseDenyTools(value) {
  if (value === undefined || value === '') return [];
  const list = String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const d of list)
    if (!DENY_PATTERN.test(d)) throw new Error('HUB_DENY_TOOLS has an entry that is not allowed');
  return [...new Set(list)];
}

function loadGatewayConfig(env = process.env) {
  const need = (k) => {
    if (!env[k] || !path.isAbsolute(env[k])) throw new Error(`${k} must be an absolute path`);
    return env[k];
  };
  const int = (k, d) => {
    const n = env[k] === undefined || env[k] === '' ? d : Number(env[k]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${k} must be a positive integer`);
    return n;
  };
  const model = env.GATEWAY_MODEL || null;
  if (model !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(model)) throw new Error('GATEWAY_MODEL is invalid');
  const dataDir = need('GATEWAY_DATA_DIR');
  const socketPath = env.GATEWAY_SOCKET ? need('GATEWAY_SOCKET') : path.join(dataDir, 'gateway.sock');
  // sun_path is about 108 bytes on Linux; a longer path fails at bind with a confusing error
  if (Buffer.byteLength(socketPath) > 100) throw new Error('the socket path is too long (100 bytes at most)');
  return {
    workspaceDir: fs.realpathSync(need('WORKSPACE_DIR')),
    dataDir,
    socketPath,
    killSwitchFile: env.KILL_SWITCH_FILE ? need('KILL_SWITCH_FILE') : path.join(dataDir, 'DISABLED'),
    auditLog: env.AUDIT_LOG ? need('AUDIT_LOG') : path.join(dataDir, 'audit.log'),
    claudeBin: env.CLAUDE_BIN || 'claude',
    model,
    denyTools: parseDenyTools(env.HUB_DENY_TOOLS),
    disabledByEnv: env.GATEWAY_DISABLED === '1',
    runTimeoutMs: int('RUN_TIMEOUT_MS', 600_000),
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 10_000),
    maxOutBytes: int('MAX_OUT_BYTES', 8 * 1024 * 1024),
    killGraceMs: int('KILL_GRACE_MS', 3000),
    killPollMs: int('KILL_POLL_MS', 1000),
    exitGraceMs: int('EXIT_GRACE_MS', 2000),
  };
}

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/** Validates one run request against the profile table. Throws an Error whose `code` is a generic reason. */
function validateRun(req) {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) throw fail('invalid');
  for (const k of Object.keys(req)) if (!REQUEST_KEYS.has(k)) throw fail('invalid');
  const { agent, conversation_id: conversationId, resume, prompt, run_id: runId } = req;
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) throw fail('invalid');
  if (!Object.hasOwn(PROFILES, agent)) throw fail('not_proxied');
  if (!PROFILES[agent].enabled) throw fail('not_enabled');
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) throw fail('invalid');
  if (typeof resume !== 'boolean') throw fail('invalid');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw fail('invalid');
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw fail('invalid');
  if (prompt.length > MAX_PROMPT_CHARS || prompt.includes('\0')) throw fail('too_large');
  return { agent, conversationId, resume, prompt, runId };
}

// Tools every web run must have denied. Apollo is never reachable from the hub, so no run may spawn it; the health
// connector patterns come from the operator's environment (HUB_DENY_TOOLS), not from this file.
const REQUIRED_DENY = Object.freeze(['Agent(apollo)']);
const DENY_PATTERN = /^(mcp__[A-Za-z0-9_*-]{1,100}|Agent\([a-z][a-z0-9_]{1,19}\))$/;
function denyList(cfg) {
  return [...new Set([...REQUIRED_DENY, ...(cfg.denyTools || [])])];
}

/** The fixed command line for a validated run. Nothing here comes from the request except the session UUID. */
function buildArgv(cfg, { agent, conversationId, resume }) {
  const p = PROFILES[agent];
  const argv = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    p.permissionMode,
    '--permission-prompts',
    'none',
    '--setting-sources',
    p.settingSources.join(','),
    '--max-turns',
    String(p.maxTurns),
    '--disallowedTools',
    ...denyList(cfg),
  ];
  if (p.kind === 'agent') argv.push('--agent', p.agent);
  if (cfg.model) argv.push('--model', cfg.model);
  argv.push(resume ? '--resume' : '--session-id', conversationId);
  assertSafeArgv(argv, agent);
  return argv;
}

// The only flags a run may carry. Anything else (--settings, --plugin-dir, --tools, --add-dir, ...) could widen
// what the run can do, so a command line with another flag is never started.
const ALLOWED_FLAGS = Object.freeze([
  '-p',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  '--permission-prompts',
  '--setting-sources',
  '--max-turns',
  '--disallowedTools',
  '--agent',
  '--model',
  '--session-id',
  '--resume',
]);
const REQUIRED_FLAGS = Object.freeze(
  ALLOWED_FLAGS.filter((f) => f !== '--agent' && f !== '--model' && f !== '--session-id' && f !== '--resume'),
);

/** Last line of defence: a command line that could skip permission checks or widen access is never started. */
function assertSafeArgv(argv, profileId) {
  for (const a of argv) {
    if (a.startsWith('-') && !ALLOWED_FLAGS.includes(a))
      throw new Error('a flag that is not on the allowed list');
  }
  for (const f of REQUIRED_FLAGS) {
    if (!argv.includes(f)) throw new Error('a required flag is missing');
  }
  if (argv.filter((a) => a === '--session-id' || a === '--resume').length !== 1)
    throw new Error('exactly one of --session-id and --resume is required');
  if (new Set(argv.filter((a) => a.startsWith('-'))).size !== argv.filter((a) => a.startsWith('-')).length)
    throw new Error('a flag is repeated');
  const agentFlags = argv.filter((a) => a === '--agent').length;
  if (agentFlags > 1) throw new Error('--agent is repeated');
  if (agentFlags === 1) {
    const id = argv[argv.indexOf('--agent') + 1];
    if (typeof id !== 'string' || !AGENT_ID.test(id) || id === 'apollo' || !Object.hasOwn(PROFILES, id))
      throw new Error('--agent names an agent that is not a hub agent');
    if (PROFILES[id].kind !== 'agent')
      throw new Error('--agent names a profile that runs as the main session');
  }
  if (profileId !== undefined) {
    const p = Object.hasOwn(PROFILES, profileId) ? PROFILES[profileId] : null;
    if (!p) throw new Error('unknown profile');
    if (p.kind === 'agent' && (agentFlags !== 1 || argv[argv.indexOf('--agent') + 1] !== profileId))
      throw new Error('--agent does not match the profile');
    if (p.kind === 'main' && agentFlags !== 0) throw new Error('the main session takes no --agent');
  }
  const di = argv.indexOf('--disallowedTools');
  const denied = [];
  for (let j = di + 1; j < argv.length && !argv[j].startsWith('-'); j++) denied.push(argv[j]);
  if (denied.some((d) => !DENY_PATTERN.test(d))) throw new Error('a denied-tool pattern is not allowed');
  for (const r of REQUIRED_DENY)
    if (!denied.includes(r)) throw new Error('a required denied tool is missing');
  if (!denied.some((d) => d.startsWith('mcp__'))) throw new Error('no connector deny pattern is set');
  const i = argv.indexOf('--permission-mode');
  if (i < 0 || !ALLOWED_PERMISSION_MODES.includes(argv[i + 1]))
    throw new Error('permission mode is not allowed');
  if (
    argv.some((a) => /bypass|dangerously|skip-permissions|(?<!dis)allowedtools|add-dir|mcp-config/i.test(a))
  )
    throw new Error('a flag that widens access is not allowed');
}

/** A minimal environment: no secrets from the gateway's own environment reach the child beyond what login needs. */
function buildEnv(cfg, runId, base = process.env) {
  const env = { PATH: base.PATH || '/usr/local/bin:/usr/bin:/bin', HUB_CHAT_RUN: '1', HUB_RUN_ID: runId };
  if (base.HOME) env.HOME = base.HOME;
  if (base.LANG) env.LANG = base.LANG;
  return env;
}

function isDisabled(cfg) {
  if (cfg.disabledByEnv) return true;
  try {
    fs.accessSync(cfg.killSwitchFile);
    return true;
  } catch {
    return false;
  }
}

/** Creates the directory private (0700) if missing; refuses anything that is not a directory owned by this user. */
function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error('a gateway directory path is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new Error('a gateway directory is not owned by the service user');
  fs.chmodSync(dir, 0o700);
}

/**
 * True unless the socket is certainly dead. Only ECONNREFUSED (nobody listens) and ENOENT (the file is gone) mean
 * dead; any other outcome (a connection, EAGAIN from a busy listener with a full accept queue, EACCES, a timeout)
 * is treated as live, so a gateway that is merely busy is never unlinked.
 */
function socketIsLive(file) {
  return new Promise((resolve) => {
    const c = net.createConnection(file);
    const timer = setTimeout(() => done(true), 1000);
    timer.unref();
    const done = (live) => {
      clearTimeout(timer);
      c.destroy();
      resolve(live);
    };
    c.once('connect', () => done(true));
    c.once('error', (e) => done(!(e && (e.code === 'ECONNREFUSED' || e.code === 'ENOENT'))));
  });
}

/**
 * Removes a leftover socket from an earlier run. A regular file, directory or link at that path is never touched,
 * and neither is a socket that something still answers on (another gateway): that is a clear error, not an unlink.
 */
async function removeStaleSocket(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new Error('the socket path exists and is not a socket; refusing to remove it');
  if (await socketIsLive(file)) throw new Error('another gateway is already listening on the socket path');
  fs.unlinkSync(file);
}

function createGateway(cfg, { log = (o) => process.stdout.write(JSON.stringify(o) + '\n') } = {}) {
  const active = new Map(); // runId -> { agent, child, cancelled }
  const busyAgents = new Set();
  // A cancel can arrive before its run is registered (Stop pressed right after Send). It is remembered for a short
  // time, and the run it names is then not started: the answer to the cancel is honest either way.
  const precancel = new Map(); // runId -> expiry (ms)
  function notePrecancel(runId) {
    const t = Date.now();
    for (const [k, exp] of precancel) if (exp <= t) precancel.delete(k);
    while (precancel.size >= PRECANCEL_MAX) precancel.delete(precancel.keys().next().value);
    precancel.set(runId, t + PRECANCEL_TTL_MS);
  }
  const finished = new Set(); // recently finished run ids: a late cancel for one of them is refused, not remembered
  function noteFinished(runId) {
    while (finished.size >= 64) finished.delete(finished.values().next().value);
    finished.add(runId);
  }
  function takePrecancel(runId) {
    const exp = precancel.get(runId);
    precancel.delete(runId);
    return exp !== undefined && exp > Date.now();
  }

  function audit(obj) {
    const line = { t: new Date().toISOString(), ...obj };
    log(line);
    try {
      fs.appendFileSync(cfg.auditLog, JSON.stringify(line) + '\n', { mode: 0o600 });
    } catch {
      // the journal copy above still exists
    }
  }

  function send(sock, obj) {
    if (!sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + '\n');
  }

  // One guarded kill sequence per run: SIGINT first (ends the turn cleanly, per the Claude Code docs), then SIGTERM,
  // then SIGKILL, on the whole process group. Signals are only sent while the child has not exited (so a late cancel
  // can never hit a recycled pid), and the group is swept with SIGKILL once, right at exit, whatever the reason.
  function makeKiller(child) {
    let exited = false;
    let started = false;
    const timers = [];
    const sig = (s) => {
      try {
        process.kill(-child.pid, s);
      } catch {
        // already gone
      }
    };
    child.once('exit', () => {
      exited = true;
      for (const t of timers) clearTimeout(t);
      sig('SIGKILL'); // anything the run left behind (a shell, a background command) goes with it
    });
    return function kill(grace) {
      if (exited || started) return;
      started = true;
      sig('SIGINT');
      const t1 = setTimeout(() => !exited && sig('SIGTERM'), Math.max(1, Math.floor(grace / 2)));
      const t2 = setTimeout(() => !exited && sig('SIGKILL'), grace);
      t1.unref();
      t2.unref();
      timers.push(t1, t2);
    };
  }

  function reject(sock, code, agent) {
    send(sock, { type: 'error', code });
    sock.end();
    audit({ event: 'rejected', agent: agent || null, code });
  }

  function startRun(sock, req) {
    let run;
    try {
      run = validateRun(req);
    } catch (e) {
      return reject(
        sock,
        e.code || 'invalid',
        typeof req?.agent === 'string' && AGENT_ID.test(req.agent) ? req.agent : null,
      );
    }
    if (isDisabled(cfg)) return reject(sock, 'disabled', run.agent);
    if (active.size >= 1 || busyAgents.has(run.agent)) return reject(sock, 'busy', run.agent);
    if (active.has(run.runId)) return reject(sock, 'invalid', run.agent);
    if (takePrecancel(run.runId)) {
      // cancelled before it started: nothing is spawned
      send(sock, {
        type: 'exit',
        code: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        tooBig: false,
        switchedOff: false,
        outBytes: 0,
      });
      sock.end();
      audit({ event: 'run', agent: run.agent, run_id: run.runId, cancelled: true, not_started: true });
      return;
    }

    const started = Date.now();
    let child;
    try {
      child = spawn(cfg.claudeBin, buildArgv(cfg, run), {
        cwd: cfg.workspaceDir,
        env: buildEnv(cfg, run.runId),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return reject(sock, 'spawn', run.agent);
    }
    const state = {
      agent: run.agent,
      child,
      cancelled: false,
      timedOut: false,
      tooBig: false,
      switchedOff: false,
    };
    state.kill = makeKiller(child);
    active.set(run.runId, state);
    busyAgents.add(run.agent);

    let buf = '';
    let outBytes = 0;
    let tokensIn = null;
    let tokensOut = null;
    const noteLine = (line) => {
      // token counts only; the line itself is forwarded but never stored
      if (line.length > 200000 || !line.includes('"type":"result"')) return;
      try {
        const o = JSON.parse(line);
        if (o && o.type === 'result' && o.usage) {
          tokensIn = Number.isFinite(o.usage.input_tokens) ? o.usage.input_tokens : null;
          tokensOut = Number.isFinite(o.usage.output_tokens) ? o.usage.output_tokens : null;
        }
      } catch {
        // not JSON
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      outBytes += Buffer.byteLength(d);
      if (outBytes > cfg.maxOutBytes && !state.tooBig) {
        state.tooBig = true;
        state.kill(cfg.killGraceMs);
      }
      if (state.tooBig) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) {
          noteLine(line);
          send(sock, { type: 'line', data: line });
        }
      }
    });
    child.stderr.on('data', () => {}); // drained, never stored or logged
    child.stdin.on('error', () => {});
    child.stdin.end(run.prompt);

    let finished = false;
    const timer = setTimeout(() => {
      if (state.exited) return; // the run already ended; only a pipe held open by a stray process is left
      state.timedOut = true;
      state.kill(cfg.killGraceMs);
    }, cfg.runTimeoutMs);

    // The hub going away (restart, crash) ends the run: nobody is left to read it, and it would hold the one slot.
    sock.on('close', () => {
      if (finished || state.exited) return; // a clean exit stays a completed run
      state.cancelled = true;
      state.kill(cfg.killGraceMs);
    });
    // The kill switch also applies to a run in progress: watched while the run lives, then the run is ended.
    const watch = setInterval(() => {
      if (state.exited || !isDisabled(cfg)) return; // a run that already ended is never reported as switched off
      state.switchedOff = true;
      state.kill(cfg.killGraceMs);
    }, cfg.killPollMs);
    watch.unref();
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      clearInterval(watch);
      if (buf && !state.tooBig) send(sock, { type: 'line', data: buf });
      active.delete(run.runId);
      noteFinished(run.runId);
      busyAgents.delete(run.agent);
      const ms = Date.now() - started;
      send(sock, {
        type: 'exit',
        code,
        signal,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        tooBig: state.tooBig,
        switchedOff: state.switchedOff,
        outBytes,
      });
      sock.end();
      audit({
        event: 'run',
        agent: run.agent,
        conversation_id: run.conversationId,
        run_id: run.runId,
        resume: run.resume,
        ms,
        code,
        signal,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        tooBig: state.tooBig,
        switched_off: state.switchedOff,
        out_bytes: outBytes,
        prompt_chars: run.prompt.length,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      });
    };
    // `close` waits for the output pipes to close. A process that escaped the group (setsid) and kept the pipe
    // open would hold the one slot forever, so shortly after `exit` the pipes are destroyed and the run is finished.
    let exitTimer = null;
    child.once('exit', (code, signal) => {
      state.exited = true;
      exitTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, cfg.exitGraceMs);
      exitTimer.unref();
    });
    child.on('error', () => finish(null, null));
    child.on('close', finish);
  }

  function handle(sock, req) {
    if (req && typeof req === 'object' && !Array.isArray(req) && 'cancel' in req) {
      const keys = Object.keys(req);
      const id = keys.length === 1 && typeof req.cancel === 'string' ? req.cancel : null;
      const found = id ? active.get(id) : null;
      const st = found && !found.exited ? found : null; // nothing to cancel once the process has exited
      if (st) {
        st.cancelled = true;
        st.kill(cfg.killGraceMs);
        send(sock, { type: 'cancelled' });
      } else if (id && !found && !finished.has(id) && RUN_ID.test(id)) {
        notePrecancel(id);
        send(sock, { type: 'cancelled', pending: true });
      } else {
        send(sock, { type: 'error', code: 'invalid' });
      }
      return sock.end();
    }
    if (
      req &&
      typeof req === 'object' &&
      !Array.isArray(req) &&
      req.op === 'status' &&
      Object.keys(req).length === 1
    ) {
      send(sock, {
        type: 'status',
        enabled: !isDisabled(cfg),
        busy: active.size >= 1,
        agents: Object.keys(PROFILES).filter((k) => PROFILES[k].enabled),
      });
      return sock.end();
    }
    startRun(sock, req);
  }

  const server = net.createServer((sock) => {
    let data = '';
    let handled = false;
    const idle = setTimeout(() => {
      if (!handled) sock.destroy();
    }, cfg.requestTimeoutMs);
    idle.unref();
    sock.on('close', () => clearTimeout(idle));
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      if (handled) return;
      data += chunk;
      if (data.length > MAX_REQUEST_BYTES) {
        handled = true;
        clearTimeout(idle);
        send(sock, { type: 'error', code: 'too_large' });
        return sock.end();
      }
      const i = data.indexOf('\n');
      if (i < 0) return;
      handled = true;
      clearTimeout(idle);
      let req;
      try {
        req = JSON.parse(data.slice(0, i));
      } catch {
        send(sock, { type: 'error', code: 'invalid' });
        return sock.end();
      }
      handle(sock, req);
    });
  });

  return {
    server,
    active,
    async listen() {
      secureDir(cfg.dataDir);
      if (path.dirname(cfg.socketPath) !== cfg.dataDir) secureDir(path.dirname(cfg.socketPath));
      await removeStaleSocket(cfg.socketPath);
      await new Promise((resolve, reject2) => {
        server.once('error', reject2);
        server.listen(cfg.socketPath, resolve);
      });
      fs.chmodSync(cfg.socketPath, 0o600);
      return cfg.socketPath;
    },
    async close() {
      for (const s of active.values()) s.kill(100);
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = {
  PROFILES,
  loadGatewayConfig,
  parseDenyTools,
  validateRun,
  buildArgv,
  assertSafeArgv,
  ALLOWED_PERMISSION_MODES,
  buildEnv,
  isDisabled,
  createGateway,
  socketIsLive,
  MAX_PROMPT_CHARS,
};

if (require.main === module) {
  const cfg = loadGatewayConfig();
  const gw = createGateway(cfg);
  gw.listen().then((sock) => {
    process.stdout.write(
      JSON.stringify({ t: new Date().toISOString(), event: 'listening', socket: path.basename(sock) }) + '\n',
    );
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gw.close().then(() => process.exit(0)));
}
