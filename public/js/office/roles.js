// Which look a key gets: a role look, a person look (`person-1` .. `person-16`), or the one fixed
// fallback look for everything else (for example `orchestrator`). Pure; never hashed or random.

import { ROLES, FALLBACK_LOOK, PERSON_LOOKS } from './sprite-format.js';

export const LOOKS = [...ROLES, FALLBACK_LOOK];
export { PERSON_LOOKS };
export const ALL_LOOKS = [...LOOKS, ...PERSON_LOOKS];

const LOOK_SET = new Set(ALL_LOOKS);

export function lookFor(id) {
  return typeof id === 'string' && LOOK_SET.has(id) ? id : FALLBACK_LOOK;
}
