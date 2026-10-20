// Which of the eight looks an agent id gets: its own for the seven roles, the one fixed
// fallback look for everything else (for example `orchestrator`). Pure; never hashed or random.

import { ROLES, FALLBACK_LOOK } from './sprite-format.js';

export const LOOKS = [...ROLES, FALLBACK_LOOK];

const ROLE_SET = new Set(ROLES);

export function lookFor(id) {
  return typeof id === 'string' && ROLE_SET.has(id) ? id : FALLBACK_LOOK;
}
