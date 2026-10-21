// Overall cost summary section. Pure rendering over store.state.costs.summary (GET /api/costs).
import { h, emptyState, displayOf, fmtTokens, fmtCost } from '../util.js';

const CLASS_LABEL = {
  input: 'Input',
  output: 'Output',
  cache_write_5m: 'Cache write (5m)',
  cache_write_1h: 'Cache write (1h)',
  cache_read: 'Cache read',
};

function table(caption, head, rows, note) {
  const t = h('table', { class: 'cost-table' }, [
    h('caption', { text: caption }),
    h('thead', {}, [
      h(
        'tr',
        {},
        head.map((t, i) => h('th', { scope: 'col', class: i ? 'num' : '', text: t })),
      ),
    ]),
    h(
      'tbody',
      {},
      rows.map((r) =>
        h(
          'tr',
          {},
          r.map((c, i) => (i ? h('td', { class: 'num', text: c }) : h('th', { scope: 'row', text: c }))),
        ),
      ),
    ),
  ]);
  return h('div', { class: 'table-wrap' }, [
    t,
    ...(note ? [h('p', { class: 'muted fold-note', text: note })] : []),
  ]);
}

function stat(label, value, sub) {
  return h('div', { class: 'stat' }, [
    h('span', { class: 'stat-label', text: label }),
    h('strong', { text: value }),
    ...(sub ? [h('span', { class: 'stat-sub', text: sub })] : []),
  ]);
}

export function mountCostSummary(store, root = document) {
  const el = root.getElementById('costs');
  const sumEl = root.getElementById('costs-summary');
  const sel = root.getElementById('costs-days');

  function render() {
    const c = store.state.costs.summary;
    if (!c) {
      sumEl.replaceChildren(
        emptyState('No cost data yet.', 'Cost appears here once agents report their token usage.'),
      );
      el.replaceChildren();
      return;
    }
    const t = c.total;
    const n = c.window.days;
    const line = [`Pricing ${c.pricing.version} (as of ${c.pricing.as_of}).`, c.window.note];
    if (t.unpriced_tokens > 0) line.push(`${fmtTokens(t.unpriced_tokens)} tokens unpriced.`);
    // Always visible, outside the collapsible body: two tiles and one line of text.
    sumEl.replaceChildren(
      h('div', { class: 'stats' }, [
        stat('Today (UTC)', fmtCost(c.today.cost_usd)),
        stat(
          `Last ${n} days`,
          fmtCost(t.cost_usd),
          `${c.sessions} sessions, ${fmtTokens(Object.values(t.tokens).reduce((x, y) => x + y, 0))} tokens`,
        ),
      ]),
      h('p', { class: 'muted summary-line', text: line.join(' ') }),
    );
    const parts = [];
    if (t.unpriced_tokens > 0) {
      parts.push(
        h('p', {
          class: 'cost-note',
          role: 'note',
          text: `${fmtTokens(t.unpriced_tokens)} tokens could not be priced (historical rows without model data, or unknown models) and are excluded from the totals.${
            c.unknown_models.length ? ` Unknown models: ${c.unknown_models.join(', ')}.` : ''
          }`,
        }),
      );
    }
    const tokenRows = Object.entries(CLASS_LABEL).map(([k, label]) => [label, fmtTokens(t.tokens[k])]);
    // days with no tokens and no cost fold into one line instead of rows of zeros
    const used = c.by_day.filter((d) => d.tokens > 0 || d.cost_usd > 0);
    const idle = c.by_day.length - used.length;
    parts.push(
      h('div', { class: 'cost-tables' }, [
        table('Tokens by class', ['Class', 'Tokens'], tokenRows),
        table(
          'Cost by model',
          ['Model', 'Tokens', 'Cost'],
          c.by_model.map((m) => [
            m.model,
            fmtTokens(Object.values(m.tokens).reduce((a, b) => a + b, 0)),
            m.priced
              ? fmtCost(m.cost_usd)
              : `${fmtCost(m.cost_usd)} (unpriced: ${fmtTokens(m.unpriced_tokens)})`,
          ]),
        ),
        table(
          'Cost by agent',
          ['Agent', 'Tokens', 'Cost'],
          c.by_agent.map((a) => [displayOf(a.agent), fmtTokens(a.tokens), fmtCost(a.cost_usd)]),
        ),
        table(
          'Cost by day (UTC)',
          ['Day', 'Tokens', 'Cost'],
          used.map((d) => [d.day, fmtTokens(d.tokens), fmtCost(d.cost_usd)]),
          idle ? `${idle} ${idle === 1 ? 'day' : 'days'} with no usage` : '',
        ),
      ]),
    );
    el.replaceChildren(...parts);
  }

  sel.addEventListener('change', () => store.setCostDays(Number(sel.value)));
  const unsub = store.subscribe((_s, what) => {
    if (what === 'all' || what === 'costs') render();
  });
  render();
  return unsub;
}
