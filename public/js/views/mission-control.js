// Mission-control view (pixel-art skin). Pure rendering over the store; the canvas office scene
// lives in ../office/ and the card portraits in ../avatar.js.
import { createOffice } from '../office/index.js';
import { createAvatar, createIcon } from '../avatar.js';
import {
  indicatorFor,
  indicatorOwners,
  stepsFor,
  INDICATORS,
  STEP_LABEL_UPPER,
  PARENT_LABEL_UPPER,
} from '../office/step-map.js';
import { agentLook } from '../office/roles.js';
import { freshHandoff, handoffText } from '../office/handoff.js';
import { h, emptyState, fmtElapsed, fmtTokens, fmtCost, fmtClock, fmtAgo } from '../util.js';

const BADGE = {
  idle: ['z', 'IDLE'],
  working: ['▶', 'WORKING'],
  blocked: ['!', 'BLOCKED'],
  done: ['✓', 'DONE'],
  resting: ['☾', 'RESTING'],
};
const STEP_LABEL = {
  spec: 'Spec',
  code: 'Code',
  verify: 'Verify',
  review: 'Review',
  'user-approval': 'User approval',
  merge: 'Merge',
  deploy: 'Deploy (server-ops)',
  cleanup: 'Cleanup',
};
// Substep labels (the gate work inside verify / review) for the chips and the failure text.
const SUBSTEP_LABEL = {
  test: 'Test',
  styling: 'Styling',
  security: 'Security',
  'code-review': 'Code review',
};
const STEP_GLYPH = { pending: '○', active: '●', passed: '✓', failed: '✗', skipped: '–' };
const DEPLOY_TEXT = {
  success: 'Deploy: SUCCESS',
  failure_rolled_back: 'Deploy: FAILED, rolled back',
  failure_rollback_failed: 'Deploy: FAILED, ROLLBACK FAILED',
};

const KIND_LABEL = { question: 'Question', server_task: 'Server task', single_role: 'Single role' };
const RUN_STATE = {
  active: ['●', 'ACTIVE'],
  passed: ['✓', 'PASSED'],
  failed: ['✗', 'FAILED'],
  abandoned: ['⊘', 'ABANDONED'],
};
const ABANDONED_GLYPH = '⊘';

// "ABANDONED / no updates for N min" (N from the last event, at least 1). Elements carry data-quiet-ts
// so the 1 s tick keeps the minutes current without a re-render.
function quietMin(ts, now) {
  return Math.max(1, Math.floor((now - ts) / 60000));
}
function abandonedText(ts, now) {
  return `ABANDONED / no updates for ${quietMin(ts, now)} min`;
}

export function mountMissionControl(store, root = document) {
  const $ = (id) => root.getElementById(id);
  const agentsEl = $('agents');
  const feedEl = $('feed');
  const feedEmpty = $('feed-empty');
  const filterEl = $('feed-filter');
  const pipeEl = $('pipeline');
  const activityEl = $('activity');
  const summaryEl = $('run-summary');
  const connEl = $('conn');
  const cards = new Map();
  const office = createOffice($('office'));
  const seenHandoffs = new Set();
  let filter = '';

  // One card per person (or per role card such as the orchestrator). The id is the person id; the
  // look and the name tag are fixed for the card's life, the role and status change.
  function makeCard(a) {
    const id = a.id;
    const look = agentLook(a);
    const name = h('span', { class: 'card-name' });
    const role = h('span', { class: 'card-role' });
    const handoff = h('div', { class: 'card-handoff', hidden: true });
    const badge = h('span', { class: 'badge' });
    const task = h('div', { class: 'task' });
    const stepLine = h('div', { class: 'step-line', hidden: true });
    const stepExtra = h('div', { class: 'step-extra muted', hidden: true });
    const rows = {};
    const kv = (label) => {
      const v = h('span');
      rows[label] = v;
      return h('div', { class: 'kv' }, [h('span', { text: label }), v]);
    };
    // Details disclosure (tokens, cost, today): closed on every load, not persisted. The body stays in
    // the DOM (hidden) so the values keep updating and text queries still match.
    const detailsId = `card-details-${id}`;
    const detailsBtn = h('button', {
      type: 'button',
      class: 'card-details-btn',
      'aria-expanded': 'false',
      'aria-controls': detailsId,
      text: 'Details',
    });
    const detailsBody = h('div', { class: 'card-details', id: detailsId, hidden: true }, [
      kv('Tokens in/out'),
      kv('Cost'),
      kv('Today'),
    ]);
    detailsBtn.addEventListener('click', () => {
      const open = detailsBtn.getAttribute('aria-expanded') !== 'true';
      detailsBtn.setAttribute('aria-expanded', String(open));
      detailsBody.hidden = !open;
    });
    office.addAgent(id, look, a.name ?? null);
    const el = h('article', { class: 'card', 'data-agent-id': id }, [
      h('div', { class: 'card-head' }, [
        h('div', { class: 'card-id' }, [createAvatar(look), name, role]),
        badge,
      ]),
      task,
      handoff,
      h('div', { class: 'card-steps' }, [stepLine, stepExtra, detailsBtn]),
      kv('Elapsed'),
      kv('Last activity'),
      detailsBody,
    ]);
    const c = { el, badge, task, name, role, handoff, rows, stepLine, stepExtra, stepKey: '', agent: null };
    cards.set(id, c);
    agentsEl.append(el);
    return c;
  }

  function renderAgents() {
    // an agent that left the snapshot loses its card and its office character
    const present = new Set(store.state.agents.map((a) => a.id));
    for (const [id, c] of cards) {
      if (present.has(id)) continue;
      office.removeAgent(id);
      c.el.remove();
      cards.delete(id);
    }
    for (const a of store.state.agents) {
      const c = cards.get(a.id) || makeCard(a);
      c.agent = a;
      const label = a.label ?? a.id;
      c.el.className = `card s-${a.status}`;
      c.el.setAttribute('aria-label', `Agent ${label}`);
      c.el.dataset.role = a.role ?? '';
      c.name.textContent = label;
      c.name.title = label;
      // a person shows the role they do now (or did last); a role card is its own role
      c.role.textContent = a.name ? (a.role ?? '') : '';
      c.role.hidden = !a.name || !a.role;
      c.badge.className = `badge s-${a.status}`;
      office.setState(a.id, a.stale ? 'idle' : a.status);
      const ht = handoffText(a.handoff, a.id);
      c.handoff.hidden = !ht;
      c.handoff.textContent = ht;
      const key = freshHandoff(a.handoff, seenHandoffs, store.now());
      if (key && a.handoff.from === a.id) {
        seenHandoffs.add(key);
        office.handoff(a.handoff.from, a.handoff.to);
      }
      c.task.textContent = a.task || (a.status === 'idle' ? 'Idle' : a.status === 'resting' ? 'Resting' : '');
      c.task.title = a.task || '';
      c.rows['Tokens in/out'].textContent = `${fmtTokens(a.tokens.in)} / ${fmtTokens(a.tokens.out)}`;
      c.rows.Cost.textContent = fmtCost(a.cost_usd) + (a.unpriced_tokens > 0 ? ' + unpriced' : '');
      c.rows.Today.textContent = `${fmtTokens(a.today.tokens.in + a.today.tokens.out)} tok, ${fmtCost(a.today.cost_usd)}`;
      tickCard(c);
    }
    renderIndicators();
    // the feed filter lists roles (events keep the role in `agent`)
    const known = new Set([...filterEl.options].map((o) => o.value));
    const roles = [...store.state.agents.map((a) => a.role), ...store.state.events.map((e) => e.agent)];
    for (const r of roles) {
      if (r && !known.has(r)) {
        known.add(r);
        filterEl.append(h('option', { value: r, text: r }));
      }
    }
  }

  // The step icon of each merged agent (verify, review): a pure function of the active steps in the
  // pipeline snapshot, the agent's status and the clock. No step data or a stale entry means none.
  function renderIndicators() {
    const active = (store.state.pipeline && store.state.pipeline.active_steps) || [];
    const now = store.now();
    // Several people can do the same role; only the newest busy one of a role shows the icon.
    const owners = indicatorOwners(store.state.agents);
    for (const [id, c] of cards) {
      const a = c.agent;
      const role = a && a.role;
      if (!role || !Object.hasOwn(INDICATORS, role)) {
        if (c.stepKey) clearIndicator(id, c);
        continue;
      }
      const busy = owners.get(role) === id;
      const ind = busy ? indicatorFor(role, active, now) : null;
      const list = ind ? stepsFor(role, active, now) : [];
      const top = list.find((s) => s.substep) || list[0];
      office.setIndicator(id, ind && ind.icon);
      const extra = ind
        ? list
            .filter((s) => s !== top)
            .map(
              (s) =>
                `${s.substep ? STEP_LABEL_UPPER[s.substep] : PARENT_LABEL_UPPER[s.step]}${s.repo ? ` (${s.repo})` : ''}`,
            )
        : [];
      const key = ind ? `${ind.step}|${ind.substep || ''}|${extra.join(',')}` : '';
      if (key === c.stepKey) continue;
      c.stepKey = key;
      c.el.dataset.step = ind ? ind.step : '';
      c.el.dataset.substep = ind && ind.substep ? ind.substep : '';
      c.stepLine.hidden = !ind;
      c.stepLine.replaceChildren(
        ...(ind ? [...(ind.icon ? [createIcon(ind.icon)] : []), h('span', { text: ind.label })] : []),
      );
      c.stepExtra.hidden = extra.length === 0;
      c.stepExtra.textContent = extra.length ? `Also: ${extra.join(', ')}` : '';
      c.stepExtra.title = c.stepExtra.textContent;
    }
  }

  function clearIndicator(id, c) {
    office.setIndicator(id, null);
    c.stepKey = '';
    c.el.dataset.step = '';
    c.el.dataset.substep = '';
    c.stepLine.hidden = true;
    c.stepLine.replaceChildren();
    c.stepExtra.hidden = true;
    c.stepExtra.textContent = '';
  }

  function tickCard(c) {
    const a = c.agent;
    if (!a) return;
    const now = store.now();
    if (a.status === 'resting') {
      const left = Math.max(0, Math.ceil(((a.cooldown_until ?? now) - now) / 1000));
      c.badge.textContent = left > 0 ? `☾ RESTING, ${left} s` : '☾ RESTING';
    } else {
      const [glyph, label] = BADGE[a.status] || BADGE.idle;
      c.badge.textContent = `${glyph} ${label}${a.stale ? ' (stale)' : ''}`;
    }
    let text = '-';
    if ((a.status === 'working' || a.status === 'blocked') && a.run_started_ts)
      text = fmtElapsed(now - a.run_started_ts);
    else if (a.since) text = `${a.status} for ${fmtElapsed(now - a.since)}`;
    c.rows.Elapsed.textContent = text;
    const last = a.last_event_ts
      ? `${fmtAgo(now - a.last_event_ts)}${a.last_summary ? ': ' + a.last_summary : ''}`
      : 'never';
    c.rows['Last activity'].textContent = last;
    c.rows['Last activity'].title = last;
  }

  function renderFeed() {
    const evs = store.state.events.filter((e) => !filter || e.agent === filter).slice(0, 100);
    const people = new Map(store.state.agents.map((a) => [a.id, a.label ?? a.id]));
    // `role · name` once the server has put a person on the event (text only)
    const whoOf = (e) => (e.instance ? `${e.agent} · ${people.get(e.instance) ?? e.instance}` : e.agent);
    feedEl.replaceChildren(
      ...evs.map((e) => {
        const ty = e.tool ? `${e.type}:${e.tool}` : e.type;
        const sum = e.summary || e.task || '';
        // one line per row; the full text is in the title attribute
        return h('li', { title: `${fmtClock(e.ts)} ${whoOf(e)} ${ty}${sum ? ': ' + sum : ''}` }, [
          h('span', { class: 't', text: fmtClock(e.ts) }),
          h('span', { class: 'who', text: whoOf(e) }),
          h('span', { class: 'ty', text: ty }),
          h('span', { class: 'sum', title: sum, text: sum }),
        ]);
      }),
    );
    feedEmpty.hidden = evs.length > 0;
  }

  // Header run summary: text only (repo, branch, attempt, status, approval tag), never colour alone.
  function renderSummary(p) {
    if (!p) {
      summaryEl.textContent = 'No active run';
      return;
    }
    const where = [p.repo, p.branch].filter(Boolean).join(' / ');
    const parts = [
      ...(where ? [h('span', { class: 'rs-where', text: where })] : []),
      h('span', { text: `Attempt ${Math.min(p.attempt, p.max_attempts)} of ${p.max_attempts}` }),
      h('span', { text: `status: ${p.status}` }),
    ];
    if (p.waiting_on_user_approval)
      parts.push(h('span', { class: 'rs-wait', text: 'WAITING ON USER APPROVAL' }));
    summaryEl.replaceChildren(...parts);
  }

  // Panel collapse state, kept in memory per run_id (not persisted). Panels are open by default.
  const panelOpen = new Map();

  // The stepper, abandoned banner and meta lines for one run.
  function renderRun(p) {
    const parts = [];
    const now = store.now();
    // Per-run banner: only this run's panel shows it.
    if (p.waiting_on_user_approval)
      parts.push(h('div', { class: 'approval', role: 'alert', text: '⚠ WAITING ON USER APPROVAL' }));
    if (p.abandoned) {
      parts.push(
        h('div', {
          class: 'abandoned-banner',
          'data-quiet-ts': String(p.updated_ts),
          text: `${ABANDONED_GLYPH} ${abandonedText(p.updated_ts, now)}`,
        }),
      );
    }
    parts.push(
      h(
        'ol',
        { class: 'stepper' },
        p.steps.map((s) => {
          const subs = Array.isArray(s.substeps) ? s.substeps : [];
          const failedSub = s.state === 'failed' ? subs.find((x) => x.state === 'failed') : null;
          const label = STEP_LABEL[s.name] || s.name;
          const ab = s.abandoned === true && s.state === 'active';
          const stText = failedSub
            ? `FAILED at ${SUBSTEP_LABEL[failedSub.name] || failedSub.name}`
            : ab
              ? abandonedText(s.ts, now)
              : s.state.toUpperCase();
          return h(
            'li',
            {
              class: `step p-${s.state}${ab ? ' abandoned' : ''}`,
              'data-step': s.name,
              'aria-label': `${label}: ${failedSub ? stText : ab ? 'abandoned' : s.state}`,
            },
            [
              h('div', { text: label }),
              h('div', {
                class: 'st',
                ...(ab ? { 'data-quiet-ts': String(s.ts) } : {}),
                text: `${ab ? ABANDONED_GLYPH : STEP_GLYPH[s.state] || ''} ${stText}`,
              }),
              ...(subs.length
                ? [
                    h(
                      'ul',
                      { class: 'substeps' },
                      subs.map((x) => {
                        const xab = ab && x.abandoned === true && x.state === 'active';
                        return h(
                          'li',
                          {
                            class: `substep s-${x.state}${xab ? ' abandoned' : ''}`,
                            'data-substep': x.name,
                            'aria-label': `${SUBSTEP_LABEL[x.name] || x.name}: ${xab ? 'abandoned' : x.state === 'skipped' ? 'skipped (not run in this attempt)' : x.state}`,
                          },
                          [
                            h('span', { text: SUBSTEP_LABEL[x.name] || x.name }),
                            h('span', {
                              class: 'sst',
                              text: xab
                                ? `${ABANDONED_GLYPH} ABANDONED`
                                : `${STEP_GLYPH[x.state] || ''} ${x.state.toUpperCase()}`,
                            }),
                          ],
                        );
                      }),
                    ),
                  ]
                : []),
            ],
          );
        }),
      ),
    );
    const meta = [
      h('div', {
        text: `Attempt ${Math.min(p.attempt, p.max_attempts)} of ${p.max_attempts}  |  status: ${p.status}`,
      }),
    ];
    const where = [p.repo, p.branch, p.commit_sha && p.commit_sha.slice(0, 10)].filter(Boolean).join(' / ');
    if (where) meta.push(h('div', { class: 'muted', text: where }));
    if (p.pr_url) meta.push(h('div', { class: 'muted', text: `PR: ${p.pr_url}` }));
    if (p.failed_gate) {
      meta.push(
        h('div', {
          class: 'pipe-fail',
          text: `Last failed gate: ${p.failed_gate}${p.last_failure ? ' - ' + p.last_failure : ''}`,
        }),
      );
    }
    if (p.deploy_result) {
      meta.push(
        h('div', {
          class: p.deploy_result === 'success' ? 'pipe-deploy-ok' : 'pipe-fail',
          text: DEPLOY_TEXT[p.deploy_result] || p.deploy_result,
        }),
      );
    }
    parts.push(h('div', { class: 'pipe-meta' }, meta));
    return parts;
  }

  function renderPanel(p) {
    const open = panelOpen.get(p.run_id) !== false;
    const bodyId = `pipe-body-${p.run_id.replace(/[^\w-]/g, '-')}`;
    const tail = p.run_id.slice(-6);
    const label = [p.repo, p.branch].filter(Boolean).join(' / ');
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'pipe-panel-toggle',
        'aria-expanded': String(open),
        'aria-controls': bodyId,
      },
      [
        h('span', { class: 'pipe-panel-where', text: label || 'unknown repo' }),
        h('span', { class: 'pipe-panel-run muted', text: `run …${tail}` }),
        h('span', { text: `Attempt ${Math.min(p.attempt, p.max_attempts)} of ${p.max_attempts}` }),
        h('span', { class: 'pipe-panel-status', text: `status: ${p.status}` }),
      ],
    );
    const bodyEl = h('div', { class: 'pipe-panel-body', id: bodyId, hidden: !open }, renderRun(p));
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-expanded') !== 'true';
      panelOpen.set(p.run_id, next);
      btn.setAttribute('aria-expanded', String(next));
      bodyEl.hidden = !next;
    });
    return h('section', { class: 'pipe-panel', 'data-run-id': p.run_id, 'aria-label': `Run ${label}` }, [
      h('h3', { class: 'pipe-panel-head' }, [btn]),
      bodyEl,
    ]);
  }

  function renderPipeline() {
    const pl = store.state.pipeline || {};
    renderSummary(pl.run);
    const runs = Array.isArray(pl.runs) ? pl.runs : [];
    if (!runs.length) {
      pipeEl.replaceChildren(
        emptyState(
          'No pipeline run yet.',
          'A run appears here when the orchestrator reports its first step.',
        ),
      );
      return;
    }
    const live = new Set(runs.map((r) => r.run_id));
    for (const id of panelOpen.keys()) if (!live.has(id)) panelOpen.delete(id);
    pipeEl.replaceChildren(...runs.map(renderPanel));
  }

  function renderActivity() {
    const runs = (store.state.pipeline && store.state.pipeline.activity_runs) || [];
    if (!runs.length) {
      activityEl.replaceChildren(
        emptyState('No other requests yet.', 'Questions, server tasks and single-role runs appear here.'),
      );
      return;
    }
    const rows = runs.map((r) => {
      const ab = r.abandoned === true;
      const [glyph, baseLabel] = RUN_STATE[ab ? 'abandoned' : r.state] || RUN_STATE.active;
      const quietTs = r.stale_since_ts ?? r.updated_ts;
      const label = ab ? abandonedText(quietTs, store.now()) : baseLabel;
      const kind = (KIND_LABEL[r.kind] || r.kind) + (r.role ? `: ${r.role}` : '');
      const end = r.ended_ts ? fmtClock(r.ended_ts) : r.state === 'active' && !ab ? 'running' : '-';
      const st = ab ? 'abandoned' : r.state;
      return h(
        'li',
        { class: `act s-${st}`, 'aria-label': `${kind}: ${ab ? 'abandoned' : label.toLowerCase()}` },
        [
          h('span', { class: 'act-kind', text: kind }),
          h('span', { class: 'act-target', text: r.target || '-' }),
          h('span', {
            class: `act-state s-${st}`,
            ...(ab ? { 'data-quiet-ts': String(quietTs) } : {}),
            text: `${glyph} ${label}`,
          }),
          h('span', { class: 'act-sum', text: r.summary || '' }),
          h('span', { class: 'act-time', text: `Start ${fmtClock(r.started_ts)}  |  End ${end}` }),
        ],
      );
    });
    activityEl.replaceChildren(h('ul', { class: 'act-list', 'aria-label': 'Non-feature runs' }, rows));
  }

  function renderConn() {
    const c = store.state.connection;
    connEl.className = `conn conn-${c}`;
    connEl.textContent = c === 'live' ? '● live' : c === 'reconnecting' ? '↻ reconnecting' : '… connecting';
  }

  filterEl.addEventListener('change', () => {
    filter = filterEl.value;
    renderFeed();
  });

  function render(_state, what) {
    if (what === 'all' || what === 'agents') renderAgents();
    if (what === 'all' || what === 'events') renderFeed();
    if (what === 'all' || what === 'pipeline') {
      renderPipeline();
      renderActivity();
      renderIndicators();
    }
    if (what === 'all' || what === 'connection') renderConn();
  }

  // Keep the "no updates for N min" minutes current between pushes.
  function tickAbandoned() {
    const now = store.now();
    for (const el of root.querySelectorAll('[data-quiet-ts]')) {
      const glyph = el.textContent.charAt(0) === ABANDONED_GLYPH ? `${ABANDONED_GLYPH} ` : '';
      const text = `${glyph}${abandonedText(Number(el.dataset.quietTs), now)}`;
      if (el.textContent !== text) el.textContent = text;
    }
  }

  const unsub = store.subscribe(render);
  render(store.state, 'all');
  const timer = setInterval(() => {
    cards.forEach(tickCard);
    renderIndicators();
    tickAbandoned();
  }, 1000);
  return () => {
    unsub();
    clearInterval(timer);
  };
}
