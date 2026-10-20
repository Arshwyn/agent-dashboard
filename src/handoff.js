'use strict';

/**
 * Inferred handoff (pure). Observed: agent X (person A, role R1) stopped at t, and agent Y (person B,
 * role R2) sent its first event at t2. Inferred: Y continues X's pipeline. There is no run link, so
 * "same pipeline" is a guess from timing and role order; the result is always flagged `inferred`.
 *
 * prev = { person, role, ts } (the stop), next = { person, role, ts } (the first event).
 * Returns { from, to, at, inferred: true } or null: same person (a role change, not a handoff), same
 * role, or outside 0 <= t2 - t <= windowMs.
 */
function detectHandoff(prev, next, windowMs) {
  if (!prev || !next) return null;
  if (prev.person === next.person || prev.role === next.role) return null;
  const dt = next.ts - prev.ts;
  if (!Number.isFinite(dt) || dt < 0 || dt > windowMs) return null;
  return { from: prev.person, to: next.person, at: next.ts, inferred: true };
}

module.exports = { detectHandoff };
