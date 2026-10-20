import { createStore } from './store.js';
import { mountCollapse } from './collapse.js';
import { mountMissionControl } from './views/mission-control.js';
import { mountCostSummary } from './views/cost-summary.js';
import { mountSessions } from './views/sessions.js';

mountCollapse();
const store = createStore({ onUnauthorized: () => (location.href = '/login') });
mountMissionControl(store);
mountCostSummary(store);
mountSessions(store);
store.start();
