// Small DOM + formatting helpers. Everything dynamic goes through textContent (never innerHTML).

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Operator-configured labels for role cards (id -> label). Display only; ids stay the data key.
let displayNames = {};
export function setDisplayNames(map) {
  displayNames = map && typeof map === 'object' ? map : {};
}
/** The configured label for an id from an id -> label map, or null; inherited keys never match. */
export function labelFrom(map, id) {
  return map && typeof map === 'object' && Object.hasOwn(map, id) ? map[id] : null;
}
export function displayOf(id) {
  return labelFrom(displayNames, id) ?? id;
}

// Empty state: a heading-level title and one line on what will appear (tokens only, no fake table).
export function emptyState(title, line) {
  return h('div', { class: 'empty' }, [
    h('h3', { class: 'empty-title', text: title }),
    h('p', { class: 'empty-line', text: line }),
  ]);
}

export function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtCost(n) {
  return '$' + (Number.isFinite(n) ? n : 0).toFixed(4);
}

export function fmtClock(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
