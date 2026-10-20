// Spot reservation. An agent holds at most one spot and a spot has at most one holder.
// Pure (no DOM); randomness is injected so tests are deterministic.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A selector is a spot kind or zone id string, or { id, kind, zone, notKind, exclude: [spotId] }.
function matcher(selector) {
  if (typeof selector === 'string') return (s) => s.kind === selector || s.zone === selector;
  const { id, kind, zone, notKind, exclude = [] } = selector || {};
  return (s) =>
    (!id || s.id === id) &&
    (!kind || s.kind === kind) &&
    (!zone || s.zone === zone) &&
    (!notKind || s.kind !== notKind) &&
    !exclude.includes(s.id);
}

export function createSpotRegistry(spots) {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const holderOf = new Map(); // spot id -> agent id
  const heldBy = new Map(); // agent id -> spot id

  function release(agentId) {
    const sid = heldBy.get(agentId);
    if (sid === undefined) return null;
    heldBy.delete(agentId);
    holderOf.delete(sid);
    return byId.get(sid);
  }

  function take(agentId, spot) {
    if (heldBy.get(agentId) === spot.id) return spot;
    release(agentId);
    holderOf.set(spot.id, agentId);
    heldBy.set(agentId, spot.id);
    return spot;
  }

  function freeSpots(selector) {
    const ok = matcher(selector);
    return spots.filter((s) => !holderOf.has(s.id) && ok(s));
  }

  return {
    // Reserves a free spot matching `selector` for the agent (random pick via rng(), else the first).
    // Idempotent: an agent already holding a matching spot keeps it. Returns the spot, or null when
    // none is free (the agent's current reservation, if any, is then left alone).
    reserve(selector, agentId, rng = null) {
      const ok = matcher(selector);
      const held = byId.get(heldBy.get(agentId));
      if (held && ok(held)) return held;
      const free = freeSpots(selector);
      if (!free.length) return null;
      return take(agentId, free[rng ? Math.min(free.length - 1, Math.floor(rng() * free.length)) : 0]);
    },
    // The agent's stable desk: the one it already holds, else the first free desk counting up from
    // a hash of its id, so the same agent tends to get the same desk. null when all desks are taken.
    reserveDesk(agentId) {
      const held = byId.get(heldBy.get(agentId));
      if (held && held.kind === 'desk') return held;
      const desks = spots.filter((s) => s.kind === 'desk');
      if (!desks.length) return null;
      const start = fnv1a(agentId) % desks.length;
      for (let i = 0; i < desks.length; i++) {
        const d = desks[(start + i) % desks.length];
        if (!holderOf.has(d.id)) return take(agentId, d);
      }
      return null;
    },
    release,
    freeSpots,
    spotOf: (agentId) => byId.get(heldBy.get(agentId)) || null,
    holderOf: (spotId) => holderOf.get(spotId) ?? null,
    spot: (id) => byId.get(id) || null,
  };
}
