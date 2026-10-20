// Client side of the inferred handoff: when a view carries a handoff that has not been shown yet and is
// still fresh, the office walks the giver beside the receiver once. Pure (no DOM). The server decides
// whether a handoff exists (src/handoff.js); this only deduplicates and ignores old ones, so a page
// reload does not replay a walk from minutes ago.

export const FRESH_MS = 10 * 1000;

export const handoffKey = (h) => `${h.from}>${h.to}@${h.at}`;

// The key to walk for, or null: a well-formed inferred handoff, not yet in `seen`, at most FRESH_MS old.
export function freshHandoff(h, seen, now, freshMs = FRESH_MS) {
  if (!h || h.inferred !== true || typeof h.from !== 'string' || typeof h.to !== 'string') return null;
  if (!Number.isFinite(h.at) || now - h.at > freshMs) return null;
  const key = handoffKey(h);
  return seen.has(key) ? null : key;
}

// Card text: the receiver reads "from A", the giver "to B". Always labelled as inferred.
export function handoffText(h, selfId) {
  if (!h || typeof h.from !== 'string' || typeof h.to !== 'string') return '';
  if (selfId === h.to) return `from ${h.from} (inferred handoff)`;
  if (selfId === h.from) return `to ${h.to} (inferred handoff)`;
  return '';
}
