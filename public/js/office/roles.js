// Which look a key gets: a role look, a person look (`person-1` .. `person-16`), or the one fixed
// fallback look for everything else (for example `orchestrator`). Pure; never hashed or random.

import { ROLES, FALLBACK_LOOK, PERSON_LOOKS, personLook } from './sprite-format.js';

export const LOOKS = [...ROLES, FALLBACK_LOOK];
export { PERSON_LOOKS };
export const ALL_LOOKS = [...LOOKS, ...PERSON_LOOKS];

const LOOK_SET = new Set(ALL_LOOKS);

export function lookFor(id) {
  return typeof id === 'string' && LOOK_SET.has(id) ? id : FALLBACK_LOOK;
}

// The look of one agent view: a person (view `slot` set) uses the person look of its pool position,
// any other card (the orchestrator, a standalone role session) its role look or the fallback.
export function agentLook(view) {
  if (view && Number.isInteger(view.slot)) return personLook(view.slot);
  return lookFor(view ? (view.role ?? view.agent ?? view.id) : null);
}
