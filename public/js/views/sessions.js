// Per-session cost list. Pure rendering over store.state.costs.sessions (GET /api/sessions).
import { SESSIONS_LIMIT } from '../store.js';
import { h, emptyState, displayOf, fmtTokens, fmtCost, fmtClock, fmtAgo } from '../util.js';

// The store caps the list at SESSIONS_LIMIT, so a full list means "at least that many".
export function sessionCountLabel(n) {
  return n >= SESSIONS_LIMIT ? `${SESSIONS_LIMIT}+` : String(n);
}

export function mountSessions(store, root = document) {
  const el = root.getElementById('sessions');
  const sumEl = root.getElementById('sessions-summary');

  function render() {
    const list = store.state.costs.sessions;
    if (!list.length) {
      sumEl.replaceChildren(
        emptyState(
          'No sessions with token usage yet.',
          'Each session that reports token usage is listed here, newest first.',
        ),
      );
      el.replaceChildren();
      return;
    }
    const now = store.now();
    const total = sessionCountLabel(list.length);
    // Always visible, outside the collapsible body: the count and the latest three sessions.
    const recent = list.slice(0, 3).map((s) =>
      h('li', { class: s.cost_incomplete ? 'sess-row unpriced' : 'sess-row' }, [
        h('span', { class: 'sess-id', title: s.session_id, text: s.session_id.slice(0, 12) }),
        h('span', { class: 'sess-agents', text: s.agents.map(displayOf).join(', ') }),
        h('span', { class: 'sess-repo', text: s.repo || '-' }),
        h('span', { class: 'sess-ago', title: fmtClock(s.last_ts), text: fmtAgo(now - s.last_ts) }),
        h('span', {
          class: 'sess-cost',
          text: fmtCost(s.cost_usd) + (s.cost_incomplete ? ' + unpriced' : ''),
        }),
      ]),
    );
    sumEl.replaceChildren(
      h('p', { class: 'sess-count', text: `${total} ${list.length === 1 ? 'session' : 'sessions'}` }),
      h('ul', { class: 'sess-list', 'aria-label': 'Latest sessions' }, recent),
      h('p', { class: 'muted summary-line', text: `Showing latest ${recent.length} of ${total}` }),
    );
    const rows = list.map((s) => {
      const tk = s.tokens;
      const cost = [fmtCost(s.cost_usd)];
      if (s.cost_incomplete)
        cost.push(
          h('span', { class: 'badge-unpriced', text: ` unpriced ${fmtTokens(s.unpriced_tokens)} tok` }),
        );
      return h('tr', { class: s.cost_incomplete ? 'unpriced' : '' }, [
        h('th', { scope: 'row', title: s.session_id, text: s.session_id.slice(0, 12) }),
        h('td', { text: s.agents.map(displayOf).join(', ') }),
        h('td', { text: s.repo || '-' }),
        h('td', { title: fmtClock(s.last_ts), text: fmtAgo(now - s.last_ts) }),
        h('td', { class: 'num', text: `${fmtTokens(tk.input)} / ${fmtTokens(tk.output)}` }),
        h('td', {
          class: 'num',
          text: `${fmtTokens(tk.cache_write_5m + tk.cache_write_1h)} / ${fmtTokens(tk.cache_read)}`,
        }),
        h('td', { class: 'num' }, cost),
      ]);
    });
    el.replaceChildren(
      h('div', { class: 'table-wrap' }, [
        h('table', { class: 'cost-table sessions-table' }, [
          h('caption', { class: 'sr-only', text: 'Cost per session, newest first' }),
          h('thead', {}, [
            h(
              'tr',
              {},
              ['Session', 'Agents', 'Repo', 'Last activity', 'In / out', 'Cache write / read', 'Cost'].map(
                (t, i) => h('th', { scope: 'col', class: i >= 4 ? 'num' : '', text: t }),
              ),
            ),
          ]),
          h('tbody', {}, rows),
        ]),
      ]),
    );
  }

  const unsub = store.subscribe((_s, what) => {
    if (what === 'all' || what === 'costs') render();
  });
  const timer = setInterval(render, 30000); // keep "x ago" fresh
  render();
  return () => {
    unsub();
    clearInterval(timer);
  };
}
