'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cleanText } = require('../../src/redact');

const GENERIC_AGENT_TYPES = new Set([
  '',
  'general-purpose',
  'explore',
  'plan',
  'claude',
  'claude-code-guide',
  'statusline-setup',
]);
const ROLE_RE = /^[A-Za-z0-9._-]{1,40}$/;

const EVENT_MAP = {
  PreToolUse: 'tool_start',
  PostToolUse: 'tool_end',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Notification: 'notification',
};

/**
 * Work out which pipeline role an event belongs to. Limits (documented in README):
 *  - A hook fires in the session that owns the settings. Subagent tool calls DO reach the parent's
 *    hooks, carrying `agent_id` + `agent_type`, but `agent_type` is the subagent *type* (for
 *    plain delegation that is "general-purpose"), not the pipeline role.
 *  - So: AGENT_DASHBOARD_ROLE (own process env) wins; then a non-generic agent_type (use named
 *    subagent types such as .claude/agents/spec.md); then the cwd basename for standalone
 *    sessions; otherwise "unknown" for an unmatched top-level session. Subagents that cannot
 *    be named (agent_id present, empty or generic agent_type) resolve to "helper".
 */
function resolveRole(input, env) {
  const fromEnv = env.AGENT_DASHBOARD_ROLE;
  if (fromEnv && ROLE_RE.test(fromEnv)) return fromEnv;
  const t = typeof input.agent_type === 'string' ? input.agent_type.trim() : '';
  if (t && !GENERIC_AGENT_TYPES.has(t.toLowerCase()) && ROLE_RE.test(t)) return t;
  if (input.agent_id) return 'helper'; // a subagent we cannot name
  const cwdRoles = (env.AGENT_DASHBOARD_CWD_ROLES || 'orchestrator,server-ops')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const base = typeof input.cwd === 'string' ? path.basename(input.cwd) : '';
  if (base && cwdRoles.includes(base)) return base;
  return 'unknown';
}

function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** Short, redacted descriptor of a tool call. Never includes file contents or command output. */
function describeTool(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const str = (v, n) => (typeof v === 'string' ? cleanText(v, n) : '');
  let d = '';
  switch (tool) {
    case 'Bash':
      d = str(i.command, 80);
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      d = str(i.file_path || i.notebook_path, 120);
      break;
    case 'Glob':
    case 'Grep':
      d = str(i.pattern, 60);
      break;
    case 'WebFetch':
      d = host(i.url);
      break;
    case 'Agent':
    case 'Task':
      d = [str(i.subagent_type, 30), str(i.description, 60)].filter(Boolean).join(': ');
      break;
    default:
      d = '';
  }
  return d ? `${tool}: ${d}` : String(tool || '');
}

const MODEL_RE = /^[A-Za-z0-9._:@/-]{1,80}$/;
const MAX_MODELS = 20;

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** The five billable token classes of one `message.usage` object (numbers only). */
function usageClasses(u) {
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const w5 = cc ? n(cc.ephemeral_5m_input_tokens) : 0;
  const w1h = cc ? n(cc.ephemeral_1h_input_tokens) : 0;
  // Without a TTL split every cache write is treated as 5-minute; any remainder of the total
  // that the split does not account for is also 5-minute.
  const total = n(u.cache_creation_input_tokens);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cache_write_5m: w5 + Math.max(0, total - w5 - w1h),
    cache_write_1h: w1h,
    cache_read: n(u.cache_read_input_tokens),
  };
}

/**
 * Sum token usage from a transcript, grouped by `message.model`. Reads numbers and the model id
 * only; message text is never retained. A message that appears on several lines (streaming
 * updates) is counted once, keeping the largest value of each class.
 * Returns { tokens_in, tokens_out, usage } or null when unreadable. `tokens_in` is
 * input + cache writes (unchanged meaning); cache reads live only in `usage`.
 */
function sumTranscriptUsage(file, { maxBytes = 20 * 1024 * 1024 } = {}) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const seen = new Map(); // dedupe key -> { model, c }
    const loose = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // tolerate malformed lines
      }
      const u = o && o.message && o.message.usage;
      if (!u || typeof u !== 'object') continue;
      const m = o.message.model;
      const model = typeof m === 'string' && MODEL_RE.test(m) ? m : 'unknown';
      const c = usageClasses(u);
      const key = o.message.id || o.uuid;
      if (!key) {
        loose.push({ model, c });
        continue;
      }
      const prev = seen.get(key);
      if (!prev) seen.set(key, { model, c });
      else for (const k of Object.keys(c)) prev.c[k] = Math.max(prev.c[k], c[k]);
    }
    const usage = {};
    for (const { model, c } of [...seen.values(), ...loose]) {
      if (!usage[model] && Object.keys(usage).length >= MAX_MODELS) continue;
      const t =
        usage[model] ||
        (usage[model] = { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 });
      for (const k of Object.keys(c)) t[k] += c[k];
    }
    for (const model of Object.keys(usage)) {
      if (Object.values(usage[model]).every((x) => x === 0)) delete usage[model];
    }
    let tokens_in = 0;
    let tokens_out = 0;
    for (const t of Object.values(usage)) {
      tokens_in += t.input + t.cache_write_5m + t.cache_write_1h;
      tokens_out += t.output;
    }
    return { tokens_in, tokens_out, usage };
  } catch {
    return null;
  }
}

/** Convert a Claude Code hook payload into a dashboard event (or null if not applicable). */
function buildEvent(input, env = process.env, now = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  const type = EVENT_MAP[input.hook_event_name];
  if (!type) return null;
  const agent = resolveRole(input, env);
  const sid = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9._:@/-]/g, '_');
  const session_id = (
    input.agent_id ? `${sid}:${String(input.agent_id).replace(/[^A-Za-z0-9._-]/g, '_')}` : sid
  ).slice(0, 100);
  const ev = { ts: now, agent, session_id, type };
  if (type === 'tool_start' || type === 'tool_end') {
    ev.tool = String(input.tool_name || '').slice(0, 64);
    ev.summary = describeTool(input.tool_name, input.tool_input);
  } else if (type === 'notification') {
    ev.summary = cleanText(input.message, 120) || cleanText(input.notification_type, 60);
    ev.meta = { notification_type: String(input.notification_type || '').slice(0, 40) };
  } else if (type === 'subagent_stop') {
    ev.summary = 'subagent finished';
    if (typeof input.agent_transcript_path === 'string') {
      const usage = sumTranscriptUsage(input.agent_transcript_path);
      if (usage) Object.assign(ev, usage);
    }
  } else {
    ev.summary = 'turn finished';
    // The orchestrator stops on every handoff, so send a cumulative snapshot of the whole
    // session transcript; the server keeps only the delta since the previous snapshot.
    if (!input.agent_id && typeof input.transcript_path === 'string') {
      const maxBytes = Number(env.AGENT_DASHBOARD_MAX_TRANSCRIPT_BYTES) || undefined;
      const usage = sumTranscriptUsage(input.transcript_path, { maxBytes });
      if (usage && Object.keys(usage.usage).length) {
        Object.assign(ev, usage, { usage_scope: 'session_cumulative' });
      }
    }
  }
  if (env.AGENT_DASHBOARD_TASK) ev.task = cleanText(env.AGENT_DASHBOARD_TASK, 200);
  if (env.AGENT_DASHBOARD_REPO) ev.repo = cleanText(env.AGENT_DASHBOARD_REPO, 100);
  return ev;
}

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The run id named by the `run-id: <id>` line of a spawn prompt, or null. Exactly one distinct id is
 * allowed: no line, an invalid id, or two different ids (even if one is invalid) give null.
 */
function runIdFromPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const ids = new Set();
  for (const m of prompt.matchAll(/^[ \t]*run-id:(.*)$/gm)) {
    const id = m[1].trim();
    if (!RUN_ID_RE.test(id)) return null;
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * The `link` event for a background Agent/Task spawn, or null. Sent in addition to the PostToolUse
 * event of the spawn: it ties the subagent session `<sid>:<agentId>` to the run named in the prompt.
 * Only the run id leaves the process; the prompt and the rest of tool_input are never sent. Foreground
 * spawns carry no agent id while they run, so they are never linked.
 */
function buildLinkEvent(input, _env = process.env, now = Date.now()) {
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'PostToolUse') return null;
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return null;
  const res = input.tool_response;
  if (!res || typeof res !== 'object') return null;
  if (res.isAsync !== true && res.status !== 'async_launched') return null;
  const agentId = typeof res.agentId === 'string' ? res.agentId : res.agent_id;
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const run_id = runIdFromPrompt(ti.prompt);
  if (!run_id) return null;
  const sid = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9._:@/-]/g, '_');
  const t = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
  const agent = t && !GENERIC_AGENT_TYPES.has(t.toLowerCase()) && ROLE_RE.test(t) ? t : 'helper';
  return { ts: now, agent, session_id: `${sid}:${agentId}`.slice(0, 100), type: 'link', meta: { run_id } };
}

function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no file is fine */
  }
  return out;
}

/** curl -K config text (keeps the bearer token off the process argv). */
function curlConfig({ url, token, body, maxTime = 2 }) {
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    `url = ${q(url)}`,
    'silent',
    `max-time = ${maxTime}`,
    'connect-timeout = 1',
    'output = "/dev/null"',
    `header = ${q('Content-Type: application/json')}`,
    `header = ${q('Authorization: Bearer ' + token)}`,
    `data-binary = ${q(body)}`,
    '',
  ].join('\n');
}

module.exports = {
  resolveRole,
  describeTool,
  buildEvent,
  buildLinkEvent,
  runIdFromPrompt,
  sumTranscriptUsage,
  loadEnvFile,
  curlConfig,
  EVENT_MAP,
};
