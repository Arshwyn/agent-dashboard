'use strict';

const REDACTED = '[REDACTED]';

const R = REDACTED;
// Hard cap on text handed to the regex engine. Callers truncate to far less afterwards, and
// bounding input keeps any residual superlinear pattern from stalling the event loop.
const MAX_REDACT_INPUT = 8192;
const whole = () => R;
// Order matters: block patterns first, then specific token shapes, then generic assignments.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, whole],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, whole],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/g, whole],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, whole],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, whole],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, whole],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, whole],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, whole],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, whole],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, whole],
  // KEY=value, TOKEN: value, password=value, secret=..., aws_secret_access_key=...
  [
    /\b([A-Za-z0-9_.-]{0,40}(?:key|token|secret|passw(?:or)?d|pwd|credential|authorization)[A-Za-z0-9_.-]{0,40})(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&;]+)/gi,
    (_m, name, sep) => `${name}${sep}${R}`,
  ],
  // CLI forms: curl -u user:pass, --user/--proxy-user user:pass
  [/(\s(?:-u|--user|--proxy-user)(?:\s+|=))[^\s:]+:\S+/g, (_m, a) => `${a}${R}`],
  // --password hunter2 / --token abc (space-separated flag values)
  [
    /(\s--?[\w-]{0,40}(?:passw(?:or)?d|passwd|token|secret|api-?key|credential)[\w-]{0,40}\s+)(?!-)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, a) => `${a}${R}`,
  ],
  // mysql -phunter2 (no space is the only form that takes the password inline)
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]{0,200}?\s-p)(?=[^\s-])\S+/g, (_m, a) => `${a}${R}`],
  // export FOO=hunter2
  [/(\bexport\s+[A-Za-z_]\w*=)("[^"]*"|'[^']*'|\S+)/g, (_m, a) => `${a}${R}`],
  // Bare long hex strings (e.g. openssl rand -hex 24). 43+ chars so 40-char git SHAs survive.
  [/\b[a-f0-9]{43,}\b/gi, whole],
  // URL userinfo: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi, (_m, a, _b, c) => `${a}${R}${c}`],
];

const SENSITIVE_KEY = /(token|secret|passw|api_?key|authorization|cookie|credential|private_?key)/i;

function redactString(input) {
  if (typeof input !== 'string') return input;
  let out = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) : input;
  for (const [re, fn] of PATTERNS) out = out.replace(re, fn);
  return out;
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

// Strip control characters (keeps tab/newline collapsed to a space) and redact.
function cleanText(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  // Bound before redacting (redaction can shorten, so keep slack beyond max).
  return truncate(redactString(s.length > max * 4 ? s.slice(0, max * 4) : s), max);
}

/**
 * Sanitize a free-form meta object: bounded depth, string length and serialized size.
 * Values under sensitive-looking keys are replaced wholesale. Non-JSON values dropped.
 */
function sanitizeMeta(meta, { maxBytes = 2048, maxString = 200, maxDepth = 3 } = {}) {
  if (meta === undefined || meta === null) return null;
  const walk = (v, depth) => {
    if (typeof v === 'string') return truncate(redactString(cleanText(v, maxString * 2)), maxString);
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean' || v === null) return v;
    if (depth >= maxDepth) return undefined;
    if (Array.isArray(v)) {
      return v
        .slice(0, 20)
        .map((x) => walk(x, depth + 1))
        .filter((x) => x !== undefined);
    }
    if (typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v).slice(0, 30)) {
        const key = truncate(String(k), 40);
        if (SENSITIVE_KEY.test(key) && typeof val === 'string') {
          o[key] = REDACTED;
          continue;
        }
        const w = walk(val, depth + 1);
        if (w !== undefined) o[key] = w;
      }
      return o;
    }
    return undefined;
  };
  const clean = walk(meta, 0);
  if (clean === undefined || typeof clean !== 'object') return null;
  let json = JSON.stringify(clean);
  if (Buffer.byteLength(json) <= maxBytes) return clean;
  // Over budget: drop keys from the end until it fits.
  const keys = Object.keys(clean);
  while (keys.length && Buffer.byteLength(JSON.stringify(clean)) > maxBytes - 20) {
    delete clean[keys.pop()];
  }
  clean._truncated = true;
  json = JSON.stringify(clean);
  return Buffer.byteLength(json) <= maxBytes ? clean : { _truncated: true };
}

module.exports = { REDACTED, redactString, truncate, cleanText, sanitizeMeta, SENSITIVE_KEY };
