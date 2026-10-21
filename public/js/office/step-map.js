// Which pipeline substep a merged agent is doing, and how its icon animates. Pure ESM (no DOM), so the
// card view, the canvas renderer and the Node tests share one definition.
//
// The orchestrator spawns two merged agents, `verify` (substeps test, styling) and `review`
// (substeps security, code-review). The stepper step is the agent; the gate is a substep. The
// indicator is a pure function of the active steps in the pipeline snapshot: no new events,
// nothing parsed from output. Both shapes are accepted: `{step: 'verify', substep: 'test'}` and
// the legacy `{step: 'test'}` (an older server).

// Legacy gate name -> character (parent step).
export const STEP_TO_CHARACTER = {
  test: 'verify',
  styling: 'verify',
  security: 'review',
  'code-review': 'review',
};

// character -> substep -> icon id (see INDICATOR_IDS in sprite-format.js)
export const INDICATORS = {
  verify: { test: 'flask', styling: 'brush' },
  review: { security: 'shield', 'code-review': 'magnifier' },
};

export const STEP_LABEL_UPPER = {
  test: 'TEST',
  styling: 'STYLING',
  security: 'SECURITY',
  'code-review': 'CODE REVIEW',
};
// Labels of the parent steps, used when the agent is active without a substep.
export const PARENT_LABEL_UPPER = { verify: 'VERIFY', review: 'REVIEW' };

export const STALE_MS = 10 * 60 * 1000; // matches the server default STALE_MINUTES
export const TRANSITION_S = 0.4;

const has = (o, k) => Object.hasOwn(o, k);

// One active-step entry as { ...entry, step: <parent>, substep: <name|null> }, or null when it is
// malformed or not a verify/review entry. Legacy gate names map to their parent.
export function normalizeStep(s) {
  if (!s || typeof s.step !== 'string' || !Number.isFinite(s.ts)) return null;
  if (has(STEP_TO_CHARACTER, s.step)) return { ...s, step: STEP_TO_CHARACTER[s.step], substep: s.step };
  if (!has(INDICATORS, s.step)) return null;
  const sub = typeof s.substep === 'string' && has(INDICATORS[s.step], s.substep) ? s.substep : null;
  return { ...s, substep: sub };
}

// Active entries (newest first) that belong to `character` and are not stale. Entries that are
// malformed or belong to another character are skipped. With `runId` (the run a person is linked to)
// only the entries of that run are kept.
export function stepsFor(character, activeSteps, now, staleMs = STALE_MS, runId = null) {
  if (!Array.isArray(activeSteps) || !has(INDICATORS, character)) return [];
  return activeSteps
    .map(normalizeStep)
    .filter(
      (s) =>
        s &&
        !s.abandoned &&
        s.step === character &&
        now - s.ts <= staleMs &&
        (runId === null || s.run_id === runId),
    )
    .sort((a, b) => b.ts - a.ts);
}

// The indicator of one character: { step, substep, icon, label } for the newest active entry that
// has a substep, else for a parent-only entry (text label, no icon), or null.
export function indicatorFor(character, activeSteps, now, staleMs = STALE_MS, runId = null) {
  const list = stepsFor(character, activeSteps, now, staleMs, runId);
  const top = list.find((s) => s.substep) || list[0];
  if (!top) return null;
  return top.substep
    ? {
        step: character,
        substep: top.substep,
        icon: INDICATORS[character][top.substep],
        label: STEP_LABEL_UPPER[top.substep],
      }
    : { step: character, substep: null, icon: null, label: PARENT_LABEL_UPPER[character] };
}

// Frames to draw for an icon change prev -> cur, `elapsed` seconds after the change: a list of
// { icon, alpha, dy }. The old icon leaves (rises and fades) in the first half, the new one arrives
// (drops into place) in the second. Reduced motion, or a time past the transition, gives the final
// icon only.
export function iconFrames(prev, cur, elapsed, reduced = false) {
  const settled = cur ? [{ icon: cur, alpha: 1, dy: 0 }] : [];
  if (reduced || prev === cur || !Number.isFinite(elapsed) || elapsed >= TRANSITION_S) return settled;
  const t = Math.max(0, elapsed) / TRANSITION_S;
  if (t < 0.5) return prev ? [{ icon: prev, alpha: 1 - t * 2, dy: -Math.round(t * 2 * 3) }] : [];
  const k = (t - 0.5) * 2;
  return cur ? [{ icon: cur, alpha: k, dy: Math.round((1 - k) * 3) }] : [];
}

// A person linked to a run carries a `run_id` string (see the person view); others have none.
export const isLinked = (a) => !!a && typeof a.run_id === 'string' && a.run_id !== '';
// Busy for the icon: working or blocked and not stale.
export const isBusy = (a) => !!a && !a.stale && (a.status === 'working' || a.status === 'blocked');

// Active entries that no linked busy person has claimed. A linked busy person of a merged role owns
// the entries of its own run for that step; an unlinked person only ever gets what is left (and
// entries without a run id are never claimed).
export function unclaimedSteps(activeSteps, agents) {
  if (!Array.isArray(activeSteps)) return [];
  const claimed = new Set();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (isLinked(a) && isBusy(a) && typeof a.role === 'string' && has(INDICATORS, a.role))
      claimed.add(`${a.run_id}|${a.role}`);
  }
  if (!claimed.size) return activeSteps;
  return activeSteps.filter((s) => {
    const n = normalizeStep(s);
    return !(n && typeof n.run_id === 'string' && claimed.has(`${n.run_id}|${n.step}`));
  });
}

// Which card shows the step icon of each merged role when it is not linked to a run. Several people can
// do the same role at once (two verify agents); without a run link there is no way to tell their steps
// apart, so only the newest busy unlinked person of a role shows the icon. Linked people show the icon
// of their own run (see `indicatorFor` with a run id) and do not compete here. `agents` are agent views
// ({ id, role, status, stale, run_id, run_started_ts, last_event_ts }). Returns Map role -> id. Pure;
// ties go to the lowest id.
export function indicatorOwners(agents) {
  const owners = new Map();
  const rank = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || typeof a.role !== 'string' || !has(INDICATORS, a.role)) continue;
    if (isLinked(a) || !isBusy(a)) continue;
    const t = Number.isFinite(a.run_started_ts) ? a.run_started_ts : (a.last_event_ts ?? 0);
    const best = rank.get(a.role);
    if (best === undefined || t > best.t || (t === best.t && a.id < best.id)) {
      rank.set(a.role, { t, id: a.id });
      owners.set(a.role, a.id);
    }
  }
  return owners;
}
