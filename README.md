# agent-dashboard

A "mission control" web dashboard for the Claude Code pipeline agents (`spec`, `code`, `cleanup`, `server-ops`, `ask`, `verify` and `review`; see "Merged agents" and "Untracked agents"). The pipeline stepper shows one step per agent (`verify`, `review`); the gate work inside them (`test`, `styling`, `security`, `code-review`) is a substep. It ingests events from Claude Code hooks, stores them in
SQLite, derives per-agent state and pipeline progress, and pushes everything live to the browser over SSE.

- Node 20, plain `http` server, `better-sqlite3` (pinned to 11.10.0, which has prebuilt binaries for Node 20), no frontend framework, no CDN.
- Default port: **8787**.
- Pixel-art skin: retro theme plus a canvas virtual office where each agent walks between desks, lounge, kitchen and more (see [Adding a skin](#adding-a-skin)).
- Layout ("command centre"): a sticky header (title, connection state, run summary, Sign out), then the pipeline as one panel per active feature run (abandoned runs leave after a window; stacked, each collapsible, with its own compact one-row stepper and inline substep chips), the office (box capped at 420 px, zoom and pan kept), the agents grid beside the live feed on desktop, then cost summary, sessions and other requests. Every section has a collapse button in its heading; cost summary and sessions start collapsed. Content is at most 1440 px wide; breakpoints are 768 px (agents in two columns, stepper 4 + 4) and 1200 px (desktop grid, stepper in one row); phones get one column and a 2x4 stepper.

## Quick start

```bash
cp .env.example .env
# fill in two DIFFERENT random secrets (this does not print them):
sed -i "s|^INGEST_TOKEN=.*|INGEST_TOKEN=$(openssl rand -hex 24)|; s|^DASHBOARD_TOKEN=.*|DASHBOARD_TOKEN=$(openssl rand -hex 24)|" .env
docker compose up -d --build
curl -s http://localhost:8787/healthz   # -> ok
```

Open `http://<host>:8787/`, sign in with `DASHBOARD_TOKEN`. To see it working without real agents:

```bash
INGEST_TOKEN=... DEMO_URL=http://localhost:8787 npm run demo        # ~20s scripted pipeline run
```

Local (no Docker): `npm ci && INGEST_TOKEN=... DASHBOARD_TOKEN=... npm start`.
Dev: `npm test`, `npm run lint`, `npm run format`.

## Configuration

| Variable                 | Default                                                | Meaning                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INGEST_TOKEN`           | required                                               | Bearer token for `POST /event`. Held by hooks. Cannot read any data.                                                                                                            |
| `DASHBOARD_TOKEN`        | required                                               | Password for the UI and `/api/*`. Must differ from `INGEST_TOKEN`.                                                                                                              |
| `PORT`                   | `8787`                                                 | Host port (compose) / listen port (bare node). The container always listens on 8787.                                                                                            |
| `BIND_ADDR`              | `127.0.0.1`                                            | Compose only: host interface to publish on. Loopback by default; set to the LAN IP for LAN.                                                                                     |
| `HOST`                   | `0.0.0.0`                                              | Bare node listen address.                                                                                                                                                       |
| `DB_PATH`                | `./data/dashboard.db` (`/data/dashboard.db` in Docker) | SQLite file.                                                                                                                                                                    |
| `RETENTION_DAYS`         | `30`                                                   | Events older than this are pruned (hourly and at startup).                                                                                                                      |
| `MAX_ROWS`               | `200000`                                               | Hard cap on stored events (oldest pruned first).                                                                                                                                |
| `DONE_TO_IDLE_SECONDS`   | `60`                                                   | `done` becomes `idle` after this long.                                                                                                                                          |
| `STALE_MINUTES`          | `10`                                                   | A `working` agent with no events for this long is shown as `idle` (stale).                                                                                                      |
| `PIPELINE_STALE_MINUTES` | `60`                                                   | A pipeline run, step or "Other requests" row with no pipeline event for this long (event `ts`, integer >= 1) is reported as `abandoned`; see "Run kinds".                       |
| `MAX_ATTEMPTS`           | `3`                                                    | Retry budget shown as "attempt n of N".                                                                                                                                         |
| `AGENTS`                 | the 7 roles                                            | Comma list of cards always shown (any other agent seen in events also gets a card). Retired names and `unknown` are dropped with a startup warning (`unknown` is never a card). |
| `COOKIE_SECURE`          | `true`                                                 | Adds `Secure` to the session cookie and sends HSTS. Set `false` only for plain-HTTP LAN.                                                                                        |
| `TRUST_PROXY`            | `false`                                                | Set `true` behind a reverse proxy so login throttling uses the last `X-Forwarded-For` hop.                                                                                      |
| `SESSION_HOURS`          | `12`                                                   | Login session lifetime.                                                                                                                                                         |
| `MAX_BODY_BYTES`         | `65536`                                                | `POST /event` body cap (413 beyond).                                                                                                                                            |
| `MAX_SSE_CLIENTS`        | `50`                                                   | Concurrent stream cap.                                                                                                                                                          |
| `MAX_AGENTS`             | `100`                                                  | Distinct agent names accepted; events for new names beyond this get `422`.                                                                                                      |
| `MAX_RUNS`               | `50`                                                   | Pipeline runs kept in memory (least recently updated evicted).                                                                                                                  |
| `PRICING_FILE`           | built-in table                                         | Optional JSON pricing table that replaces the built-in one (see "Tokens and cost").                                                                                             |
| `OFFICE_LAYOUT_PATH`     | unset                                                  | Optional hand-edited office layout JSON served at `GET /api/office-layout` (see "Office layout override").                                                                      |
| `INGEST_RATE_PER_MIN`    | `600`                                                  | Per-IP cap on authenticated `POST /event` requests per minute (`429` beyond).                                                                                                   |

### Deployment modes

**A. Behind a TLS reverse proxy (recommended).** Keep the defaults: `BIND_ADDR=127.0.0.1` (proxy on the same host)
or the Docker network/LAN IP the proxy reaches, `COOKIE_SECURE=true`, and set `TRUST_PROXY=true` so failed-login and
ingest throttling is per real client instead of per proxy IP. The proxy must set `X-Forwarded-For`
(the last hop is used) and should overwrite any client-supplied value.

**B. LAN-only plain HTTP.** Browsers do not store `Secure` cookies over plain HTTP, so you must opt out explicitly:
`COOKIE_SECURE=false` and `BIND_ADDR=<server LAN IP>`, leave `TRUST_PROXY=false`. Tokens and the session cookie are
then readable by anyone on the network path; only do this on a network you trust. The server prints a startup warning
when it listens on a non-loopback address with `COOKIE_SECURE=false`.

The server **refuses to start** if a token is unset, shorter than 20 characters, looks like a placeholder
(`changeme`, `password`, `example`, ...), has very low variety, or if both tokens are equal. There are no insecure defaults.

## HTTP API

| Endpoint                                | Auth                                   | Description                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /event`                           | `Authorization: Bearer <INGEST_TOKEN>` | Ingest one event. `201 {ok,id}`, `400` invalid, `401`, `413` > 64 KB, `429` after repeated bad tokens.                                                                               |
| `GET /healthz`                          | none                                   | Returns only `ok`.                                                                                                                                                                   |
| `GET /api/agents`                       | dashboard                              | Per-agent state (see below).                                                                                                                                                         |
| `GET /api/events?limit=&before=&agent=` | dashboard                              | Newest first. `limit` <= 200, `before` is an event id cursor; response has `next_before`.                                                                                            |
| `GET /api/sessions?limit=`              | dashboard                              | Cost per session, newest first (`limit` default 50, max 200). See "Tokens and cost".                                                                                                 |
| `GET /api/costs?days=`                  | dashboard                              | Overall cost summary for the last N UTC days (default 7, max `RETENTION_DAYS`).                                                                                                      |
| `GET /api/pipeline`                     | dashboard                              | Current pipeline run (`steps[].substeps`) + `runs` (one per panel), `recent_runs`, `activity_runs`, `active_steps[].substep`; stale items carry `abandoned` / `status: 'abandoned'`. |
| `GET /api/office-layout`                | dashboard                              | The `OFFICE_LAYOUT_PATH` file, re-read per request: `200`, `404` (unset/missing), `413`, `422`. No parameters.                                                                       |
| `GET /api/stream`                       | dashboard                              | SSE: `event`, `agent`, `pipeline`, `resync`; `: heartbeat` comment every 20s; honours `Last-Event-ID`.                                                                               |
| `GET /`, static files                   | dashboard (cookie)                     | Mission-control UI. Unauthenticated users are redirected to `/login`.                                                                                                                |

Dashboard auth is a session cookie (`HttpOnly; SameSite=Strict`) from the `/login` form, or `Authorization: Bearer <DASHBOARD_TOKEN>` for scripts. Login failures are throttled (5 per 5 minutes per client IP).

### Event schema

```json
{
  "ts": 1760767200000,
  "agent": "code",
  "session_id": "abc123",
  "type": "tool_start",
  "tool": "Bash",
  "summary": "Bash: npm test",
  "task": "Implement feature",
  "repo": "example-app",
  "branch": "feat/x",
  "tokens_in": 1200,
  "tokens_out": 300,
  "cost_usd": 0.012,
  "usage": {
    "claude-sonnet-5-5": {
      "input": 10,
      "output": 5,
      "cache_write_5m": 0,
      "cache_write_1h": 0,
      "cache_read": 900
    }
  },
  "usage_scope": "delta",
  "meta": {}
}
```

Required: `ts` (epoch s/ms or ISO-8601, not in the future), `agent` (free-form id, `[A-Za-z0-9._:@/-]`, <= 40, so new agents need no code change), `session_id`, `type`
(`tool_start | tool_end | subagent_stop | stop | notification | status | pipeline`). Everything else is optional. `tokens_*` and `cost_usd` are **increments** attributed to that event. `usage` (per-model token classes, at most 20 models, model id `[A-Za-z0-9._:@/-]{1,80}`) and `usage_scope` (`delta` default, or `session_cumulative`, valid on `stop` only) are described under "Tokens and cost". Old senders that only send `tokens_in/out` and an optional `cost_usd` still validate.

Server-side defence in depth on ingest: only these fields are stored (a `tool_input`/`tool_response`/file contents sent by a client is dropped); strings have control characters removed, are redacted and truncated (`summary` 200 chars, 400 for `pipeline` events); `meta` is depth/size-capped (2 KB) and values under keys like `token`, `password`, `secret`, `authorization` are replaced; secret patterns
(Bearer tokens, `sk-...`, `ghp_/gho_/...`, `github_pat_...`, JWTs, `*_KEY=`/`*_TOKEN=`/`password=` assignments, AWS keys, private key blocks, URL passwords) become `[REDACTED]`.

### Derived agent status

`GET /api/agents` returns, per agent: `status`, `stale`, `current_task`, `since` (when the current status began), `run_started_ts` (for the live elapsed timer), `last_event_ts`, `last_summary`, `tokens {in,out}` and `cost_usd` for the current run, and `today {tokens, cost_usd}` (UTC day).

Status rules (the enum is stable: `idle | working | blocked | done`):

1. `tool_start`, `tool_end`, `status` events -> `working`. (A `status` event may carry `meta.state` to set `idle|working|blocked|done` explicitly.)
2. `notification` (permission or idle prompt) -> `blocked`, until the next activity event.
3. `stop` / `subagent_stop` -> `done`, then `idle` after `DONE_TO_IDLE_SECONDS`.
4. `working` with no events for `STALE_MINUTES` -> shown as `idle` with `stale: true`.
5. Activity after `idle`/`done` starts a new run: run totals and the task reset, `today` keeps accumulating.
6. `pipeline` events never change agent cards; they feed only the pipeline view. Pipeline staleness is separate: it uses `PIPELINE_STALE_MINUTES` (default 60), not `STALE_MINUTES` (see "Run kinds").

## Installing the Claude Code hooks

1. Create `~/.config/agent-dashboard/hook.env` (mode 600) on every machine that runs Claude Code sessions:
   ```
   AGENT_DASHBOARD_URL=http://<dashboard-host>:8787
   AGENT_DASHBOARD_INGEST_TOKEN=<the INGEST token, never the dashboard token>
   ```
2. Add to `~/.claude/settings.json` (or the orchestrator project's `.claude/settings.json`), with the real path to this repo:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "*",
           "hooks": [
             { "type": "command", "command": "node /path/to/agent-dashboard/scripts/hook.js", "timeout": 5 }
           ]
         }
       ],
       "PostToolUse": [
         {
           "matcher": "*",
           "hooks": [
             { "type": "command", "command": "node /path/to/agent-dashboard/scripts/hook.js", "timeout": 5 }
           ]
         }
       ],
       "SubagentStop": [
         {
           "hooks": [
             { "type": "command", "command": "node /path/to/agent-dashboard/scripts/hook.js", "timeout": 5 }
           ]
         }
       ],
       "Stop": [
         {
           "hooks": [
             { "type": "command", "command": "node /path/to/agent-dashboard/scripts/hook.js", "timeout": 5 }
           ]
         }
       ],
       "Notification": [
         {
           "hooks": [
             { "type": "command", "command": "node /path/to/agent-dashboard/scripts/hook.js", "timeout": 5 }
           ]
         }
       ]
     }
   }
   ```

`scripts/hook.js` is **fail-open**: it always exits 0, has a hard 1.5s self-timeout, and hands the request to a detached `curl --max-time 2` (the bearer token is passed on curl's stdin, not on the command line). It sends only the tool name and a short redacted descriptor (file path, first 80 chars of a Bash command, URL host); never tool input/output, file contents or command output. If the URL/token is not configured it silently does nothing.

### Role attribution and its limits (please read)

Hooks fire in the session that owns the settings. Per the current hooks documentation, tool calls made _inside_ a subagent also run the parent's configured hooks, and the payload then carries `agent_id` and `agent_type`; `SubagentStop` fires in the parent when a subagent finishes. However `agent_type` is the **subagent type** (e.g. `general-purpose`, `Explore`, or a custom name), not a pipeline role. So the hook resolves the role in this order:

1. `AGENT_DASHBOARD_ROLE` in the hook process environment (use this when a role runs as its own `claude` process, e.g. `AGENT_DASHBOARD_ROLE=server-ops claude ...`).
2. `agent_type`, **if it is not a generic built-in** (`general-purpose`, `Explore`, `Plan`, ...). To get per-role cards for orchestrator-spawned agents, define custom subagents named after the roles (`.claude/agents/spec.md`, `code.md`, `verify.md`, ...) and spawn with `subagent_type: "<role>"`.
3. For a subagent with an empty or generic type: `helper`.
4. For a top-level session: the cwd basename if it is in `AGENT_DASHBOARD_CWD_ROLES` (default `orchestrator,server-ops`), else `unknown`. `unknown` is stored with its events (cost and the feed still count it) but never gets a card (see "Untracked agents").

Consequence: if the orchestrator keeps spawning plain, unnamed agents, their tool events appear under `helper` and the role cards stay idle (the dashboard does not guess). The **pipeline view does not depend on this**: it is driven by explicit `pipeline` events from the orchestrator (below). Roles can also be driven explicitly with `status` events, e.g.
`{"agent":"code","type":"status","task":"Implement X","session_id":"orch","ts":...}`; optional env vars `AGENT_DASHBOARD_TASK` / `AGENT_DASHBOARD_REPO` add `task`/`repo` to hook events from a process.

### Tokens and cost

Cost is computed **by the server at ingest** and stored on the event, so it is auditable and survives restarts.

**What the hook sends.** On `SubagentStop` the hook reads the subagent's transcript (`agent_transcript_path`) and on every top-level `Stop` it reads the session transcript (`transcript_path`). It sums the `message.usage` numbers grouped by `message.model` (messages repeated across streaming lines are counted once, keeping the largest value per class) and sends:

- `usage`: `{ "<model id>": { input, output, cache_write_5m, cache_write_1h, cache_read } }`. Cache writes use the transcript's TTL split when present, otherwise all cache writes count as 5-minute. Only numbers and the model id are read; message text is never retained or sent. Transcripts over 20 MB (`AGENT_DASHBOARD_MAX_TRANSCRIPT_BYTES` to change) or unreadable ones send no usage (fail-open).
- `tokens_in` (`input + cache writes`, unchanged meaning) and `tokens_out`. Cache reads exist only in `usage`.

**Orchestrator spend (cumulative snapshots).** The orchestrator stops on every handoff, so its Stop events carry `usage_scope: "session_cumulative"`: the whole-session total so far. The server never adds snapshots. It keeps the latest snapshot per `session_id` (in the database, so restarts cannot double-count) and stores only the **delta** versus the previous one, per model and per class:

- an unchanged snapshot adds zero; growing snapshots always sum to the latest one;
- an older snapshot arriving after a newer one (by `ts`) adds nothing (`meta.stale_snapshot`);
- if any class went down (resumed, compacted, cleared or rewritten transcript) the new snapshot is a new baseline, counted in full, and the event gets `meta.baseline_reset: true`. Deltas are never negative. A new `session_id` starts a new baseline.

Snapshot rows are pruned with the rest of the events; if the newest snapshot of a session ages out (retention or `MAX_ROWS`) and the session later resumes, its next snapshot is counted in full again, so that session's cost can be overstated.

**Pricing.** `src/pricing.js` holds a static, versioned table copied from Anthropic's published pricing (<https://platform.claude.com/docs/en/about-claude/pricing>; USD per 1M tokens: input, output, cache write 5m, cache write 1h, cache read), keyed by model id (an id matches a key when it equals it or continues with a `-YYYYMMDD` date, `-latest` and/or `[1m]`; the longest key wins, so `claude-sonnet-4-5-20250929` matches `claude-sonnet-4-5`, while an unlisted id such as `claude-opus-4-10` is reported as unpriced instead of being matched to `claude-opus-4-1`). It carries `version` and `as_of`; every priced row stores `pricing_version`. Rates are the per-model listed values (cache read is 0.1x input except 0.025x on Fable/Mythos 5.1 and 0.05x on Opus/Sonnet 5.5), and only models that page lists are included. The one tiered model, `claude-haiku-5-5`, is billed at 5x every rate for requests whose prompt exceeds 100,000 tokens; the table holds the up-to-100K rates because usage is aggregated per session and model without per-request prompt length, so Haiku 5.5 cost can be understated. **Known limitations:** Haiku 5.5 prompts over 100K tokens are underpriced (the tier is not modelled), and older Claude 3 model ids are not in the table, so they are reported as unpriced. All other models bill the full 1M context at standard rates. To override, set `PRICING_FILE` to a JSON file:

```json
{
  "version": "my-1",
  "as_of": "2026-10-19",
  "models": {
    "claude-sonnet-5": {
      "input": 2,
      "output": 10,
      "cache_write_5m": 2.5,
      "cache_write_1h": 4,
      "cache_read": 0.2
    }
  }
}
```

Cost = sum over classes of `tokens / 1e6 * rate` (one pure function, `computeCost`). A stored row keeps the raw per-model tokens (`usage`, with each model's `cost_usd`), `cost_usd`, `cost_source` and `pricing_version`, so its cost can be re-derived.

**`cost_usd` precedence.** If an event carries `usage`, the server-computed cost always wins and a sender `cost_usd` is ignored (`cost_source: "computed"`). A sender `cost_usd` is honoured only for legacy events with no `usage` (`cost_source: "reported"`), never added to a computed cost. Events with neither are unpriced.

**Unpriced usage.** An unknown or missing model id is never priced as $0 and never guessed: its tokens are counted in `unpriced_tokens`, the session shows `cost_incomplete: true`, the UI marks it and excludes those tokens from totals with a visible note, and the server logs a one-time warning per unknown model id. Rows stored before this feature have no model data; they stay unpriced (flagged, not backfilled). The database migration adds columns with `ALTER TABLE ... ADD COLUMN` only when missing, so existing databases keep working.

**Sessions.** A session is a `session_id`; subagent events use `<sid>:<agent_id>` and roll up to the parent `<sid>`. Days are UTC; currency is USD.

`GET /api/sessions` returns `{ sessions: [{ session_id, agents, repo, subagent_sessions, first_ts, last_ts, tokens {input, output, cache_write_5m, cache_write_1h, cache_read}, legacy_tokens {in,out}, models [{model, tokens, cost_usd, unpriced_tokens, priced}], cost_usd, unpriced_tokens, cost_incomplete }], pricing, now }`.

`GET /api/costs?days=N` returns `window` (covered range; limited by `RETENTION_DAYS`), `pricing`, `total` (cost, tokens by class, `unpriced_tokens`, `cost_incomplete`), `today`, `sessions` (count), `by_model`, `by_agent`, `by_day` (every UTC day in the window) and `unknown_models`. Both are computed from the stored events on request, so they are correct after a restart. The UI refreshes them a moment after any event that carries usage.

## Wiring your own agents

Any agent runner can report to the dashboard; nothing here is tied to a particular host.

1. **Credentials.** On each machine that runs agents, create `~/.config/agent-dashboard/hook.env` (mode 600) with `AGENT_DASHBOARD_URL=http://<dashboard-host>:8787` and `AGENT_DASHBOARD_INGEST_TOKEN=<the INGEST token>` (see "Installing the Claude Code hooks"). `AGENT_DASHBOARD_ENV_FILE` points at a different file.
2. **Hooks.** Add the `settings.json` hook snippet from "Installing the Claude Code hooks", using the real path: `node <path-to-checkout>/scripts/hook.js`.
3. **Roles.** The hook resolves the role in this order: `AGENT_DASHBOARD_ROLE`, then a named (non-generic) subagent type, then the cwd basename for top-level sessions if it is in `AGENT_DASHBOARD_CWD_ROLES`; the cards shown come from `AGENTS` on the server (see "Role attribution and its limits").
4. **Pipeline events.** Call the emit script from your orchestration:
   ```bash
   E=<path-to-checkout>/scripts/emit-pipeline-event.sh
   RUN=run-$(date +%s)
   $E --run-id $RUN --step spec --state active --repo example-app
   $E --run-id $RUN --kind server_task --target app-server --state active --summary "Restart the service"
   ```

The seven role names (`spec`, `code`, `cleanup`, `server-ops`, `ask`, `verify`, `review`) and the `orchestrator` / `server-ops` cwd defaults are the vocabulary of the pipeline this dashboard was built for. They can be overridden with `AGENTS` and `AGENT_DASHBOARD_CWD_ROLES`; the bundled office art covers those seven roles.

## Pipeline events (for the orchestrator)

The orchestrator reports progress with `scripts/emit-pipeline-event.sh` (same `hook.env`, fail-open, token not on argv):

```bash
E=/path/to/agent-dashboard/scripts/emit-pipeline-event.sh
RUN=agent-dashboard-$(date +%s)
$E --run-id $RUN --step spec --state active --repo agent-dashboard
$E --run-id $RUN --step verify --state active                    # the verify agent starts
$E --run-id $RUN --step verify --substep test --state active     # gate work inside it is a substep
$E --run-id $RUN --step verify --substep test --state failed --attempt 1 --summary "npm test: 2 failing"
$E --run-id $RUN --step code --state active --attempt 2          # retry: later steps reset to pending
$E --run-id $RUN --step user-approval --state active --pr-url https://github.com/<owner>/<repo>/pull/1 --commit-sha abc123
$E --run-id $RUN --step deploy --deploy-result failure_rolled_back --summary "healthcheck failed"
```

It posts `type: "pipeline"` events with `meta: {run_id, step, substep, state, attempt, failed_gate, repo, branch, pr_url, commit_sha, deploy_result}`.
Steps, in order (8): `spec code verify review user-approval merge deploy cleanup`. States: `pending active passed failed`.
Substeps: `test` and `styling` belong to `verify`, `security` and `code-review` to `review`. `substep` is optional, an enum, and only valid with a state on its parent step; the script does not send it otherwise, and the server drops any other combination (the event is still accepted and the step is kept as sent). A substep is never a stepper step: the stepper shows two chips under Verify and two under Review, each with a text state and a glyph.
`deploy_result` is `success | failure_rolled_back | failure_rollback_failed` (sets the deploy step passed/failed if no `--state`).
`attempt` is the shared retry counter (max over events; shown as "attempt n of 3"); `failed_gate`/`last_failure` persist until the run ends. Activating a step (no substep) resets every later step to `pending` and clears that step's substeps; a substep event updates only that substep and never resets anything (a substep event older than the stored one for the same substep is ignored; equal timestamps apply in arrival order).
Parent state is derived (first match wins): a failed substep fails the parent (`failed_gate` is the substep name, `last_failure` its summary, and the stepper reads "FAILED at <substep>"); an explicit `passed`/`failed` on the parent; an active substep; all seen substeps passed while a later step is active or passed (implicit end, for runs that never send a parent end event); otherwise active once any substep was seen, else pending. A substep with no recorded event is shown as `skipped` (glyph `–`, text SKIPPED, `aria-label` "skipped (not run in this attempt)") when its parent's derived state is `passed` (for example a retry that re-uses Review with `--state passed`), and stays `pending` under a `failed`, `active` or `pending` parent; recorded substeps keep their own state, and `skipped` never counts as active. The `Last failed gate` line is unchanged: `failed_gate` is not cleared by a later pass. `--step verify --state failed` fails the parent with `failed_gate` verify unless `--failed-gate` is given. `code --state active` (a retry) clears verify and review with their substeps.
**Legacy names.** `--step test|styling|security|code-review` (no `--substep`) is still accepted and normalised at ingest to its parent plus substep (`--step test` is verify / test), and never creates a card; stored rows are not rewritten, so DB replay and in-flight runs render the new way with no migration. A run that mixes legacy and new names for the same agent shows one parent with the union of its substeps.
Run status: `running | waiting_approval | failed` (a failed gate/step on the last attempt, or a failed deploy) `| complete` (cleanup passed). `user-approval` active renders the prominent **WAITING ON USER APPROVAL** banner.

### Run kinds (non-feature requests)

Every request the orchestrator handles can be a run. `--kind` (sent as `meta.kind`) is one of `feature` (default; the stepper above), `question` (`ask`), `server_task` (`server-ops` `SERVER-REQUEST`) or `single_role` (one named role). A missing or unknown kind is `feature`, so old events, DB replay and old scripts behave as before. A run's kind is fixed by its first event.

```bash
$E --run-id q-$(date +%s) --kind question --target example-app --state active --summary "How does auth work?"
$E --run-id q-... --kind question --target example-app --state passed --summary "Answered"
$E --run-id s-$(date +%s) --kind server_task --target app-server --state failed --summary "nginx unhealthy"
$E --run-id r-$(date +%s) --kind single_role --step test --target example-app --state active
```

Non-feature runs show as generic activity rows ("Other requests"), never as the stepper, and never change `snapshot().run`, the stepper or its deploy result. Send `--state active` at the start and `passed` or `failed` at the end, each with `--summary` (max 400 chars after redaction) and `--target` (repo or host; falls back to `--repo`). `--step` is only used by `single_role`, where it must be one of `spec code test security styling code-review cleanup verify review` (anything else is dropped); `--substep` may accompany `verify`/`review`, and a legacy gate name implies its substep. An end event with no start still creates a run; an `active` event that is not newer than the recorded end does not reopen the run (it only fixes the start time), so out-of-order delivery is safe.

`GET /api/pipeline` and the SSE `pipeline` event carry:

```
{
  run: {...feature run, kind: 'feature'} | null,      // latest feature run only; steps: [{name, state, ts,
                                                       // summary, substeps}] (8 steps; substeps is the two
                                                       // canonical [{name, state, ts, summary}] for verify
                                                       // and review, [] otherwise; substep state is
                                                       // pending|active|passed|failed|skipped)
  runs: [{...feature run}],                            // one entry per pipeline panel, same shape as run:
                                                       // feature runs that are running, waiting_approval or
                                                       // abandoned (for 120 minutes after their last event,
                                                       // PANEL_ABANDONED_MINUTES, a code constant, applied on
                                                       // read), plus complete or failed runs for 10 minutes
                                                       // after their last event (PANEL_GRACE_MINUTES, a code
                                                       // constant, applied on read); max 8 (the most recently
                                                       // updated); ordered by started_ts, then run_id, so panels
                                                       // keep their place. run is unchanged
  recent_runs: [{ run_id, kind, status, repo, updated_ts }],   // 5 newest of any kind; status is
                                                       // running|waiting_approval|failed|complete|abandoned
                                                       // for features, active|passed|failed|abandoned otherwise
                                                       // (repo holds the target for non-feature runs)
  activity_runs: [{ run_id, kind, target, role, summary, state, started_ts, ended_ts, updated_ts }]
                                                       // non-feature runs, newest first, max 20;
                                                       // state is active|passed|failed|abandoned (adds
                                                       // abandoned: true, stale_since_ts), ended_ts null
                                                       // while active, role only for single_role
  active_steps: [{ run_id, repo, step, substep, ts, attempt }]
                                                       // step is a stepper step; substep is the active
                                                       // substep name or null; newest first, max 50
}
```

**Abandoned runs.** Staleness is computed on read from the event `ts` (stored events are never rewritten) against `PIPELINE_STALE_MINUTES` (default 60, strict `>`), so it also applies after a restart's replay. The server also re-diffs and pushes the `pipeline` event every 5 s, so open tabs update without a new event.

- A non-feature row (`question`, `server_task`, `single_role`) still `active` and silent past the threshold reports `state: 'abandoned'`, `abandoned: true` and `stale_since_ts` (its last event). A `question` with no answer is covered.
- A feature run that would be `running` reports `status: 'abandoned'` and `abandoned: true`. A step that is `active` and whose newest `ts` (step and substeps) is older than the threshold gets `abandoned: true` (as do its active substeps), even if other steps keep emitting; its `state` stays `active`. Abandoned items are left out of `active_steps`.
- `waiting_approval` (the `user-approval` step) is never abandoned by age: it is a human gate. `complete` and `failed` runs are never changed.
- An abandoned feature run leaves `runs[]` after `PANEL_ABANDONED_MINUTES` (120) of silence, measured from its last event, and stays in `recent_runs` with `status: 'abandoned'`; a new event brings it back.
- Any later event for the run revives it (status, `abandoned` and the step return to normal). Abandoned items are not counted as running anywhere.
- The UI greys them with a dashed border, the glyph `⊘` and the text `ABANDONED / no updates for N min`, with no animation (also under reduced motion), and hides the office indicator. Old clients ignore `abandoned` and still show `ACTIVE` for activity rows.

Non-feature runs share the in-memory `maxRuns` window and the startup rebuild from stored `pipeline` events; the current feature run is never evicted by them.

## Security notes

- UI and `/api/*` need `DASHBOARD_TOKEN`; hooks hold only `INGEST_TOKEN`, which cannot read anything. Comparisons are constant-time. Failed ingest and login attempts are throttled.
- Headers: CSP without `unsafe-inline` (`script-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. No CORS headers are sent.
- **Asset caching**: static assets are served under `/v/<hash>/...`, where `<hash>` is the first 12 hex chars of a sha256 over every file in `public/`, computed once at startup (the container is immutable per deploy). Relative `import`s and CSS `url()`s stay inside the prefix, so there is no build step. Versioned files send `Cache-Control: private, max-age=31536000, immutable` plus a strong `ETag` (`If-None-Match` gets a 304); any other version is a 404, so an old tab can never cache new content under an old URL. `/` and the login page are `no-store` and carry the current version, so a deploy shows up without a hard refresh. Legacy unversioned `/css`, `/js`, `/img` still work with `private, no-cache` + `ETag`. Every response sends `CDN-Cache-Control: no-store` and `Cloudflare-CDN-Cache-Control: no-store` so the edge does not keep authenticated content; only `/v/<hash>/css/app.css` is reachable without auth (the login page needs it). A tab opened before a deploy keeps its old version URLs and may get 404s for lazily loaded assets (e.g. CSS images) until reloaded.
- **CDN / caching proxy** (for example Cloudflare): Browser Cache TTL (Caching > Configuration) and Cache Rules can override origin `Cache-Control` on static extensions (they may rewrite `Cache-Control` on `/css`, `/js`, `/img`). Recommend honouring origin headers ("Respect Existing Headers" or the equivalent) and a rule that bypasses cache for the dashboard hostname. The app does not depend on this for its assets because of the versioned URLs; the unversioned URLs and the HTML are only protected by being `no-store`/uncached, so that override matters for them.
- The UI renders event data only through `textContent`; there is no `innerHTML`.
- Secrets live only in the environment / `.env` (gitignored). `.env.example` has placeholders only. The server never logs tokens or event bodies.
- **Transport**: the app itself speaks plain HTTP. Secure-by-default: the cookie is `Secure`, HSTS is sent, and compose publishes on loopback only. See "Deployment modes" for TLS-proxy vs. LAN-HTTP setup. Do **not** expose `POST /event` to the public internet without TLS.
- Bearer-token guesses on `/api/*` are throttled like logins (a blocked client is not even compared). Open `/api/stream` connections are closed on logout and when their session expires. Successful ingest is rate limited per IP, and distinct agents and in-memory runs are capped.
- Known trade-offs (documented, not changed): (1) the bearer/login throttle is per client IP, so someone who fails 5 attempts locks that IP out of bearer and login access for 5 minutes (existing cookie sessions keep working); with `TRUST_PROXY=false` behind a proxy all clients share the proxy IP, so keep `TRUST_PROXY` correct for your deployment. (2) `TRUST_PROXY=true` uses the rightmost `X-Forwarded-For` entry and assumes a proxy that appends to the header; never enable it without such a proxy. (3) HSTS (`max-age=31536000`, no `includeSubDomains`) is host-wide, not per port: if the dashboard is served over https on a hostname that also serves plain-HTTP services, browsers will force https for those too for a year. Use a dedicated hostname, or set `COOKIE_SECURE=false` (which also disables HSTS). (4) The ingest token holder can fill the 100 agent slots and the 50-run window; that credential is trusted by design, and can also post arbitrary `usage` / `session_cumulative` snapshots and so skew the cost figures (accepted by design).
- Redaction is best-effort pattern matching (assignments, Bearer/Basic, common token shapes, `curl -u`, `--password x`, `mysql -pX`, `export X=`, long hex strings), not a guarantee; avoid putting secrets on command lines.
- Tokens are passed as container environment variables, so users in the `docker` group can read them via `docker inspect`. Restrict that group on the host.
- The base image is pinned by digest in the `Dockerfile`; refresh it periodically (`docker buildx imagetools inspect node:20-slim`). The install script runs during `npm ci` in the build stage only (needed for the native `better-sqlite3` build).
- The container runs as the non-root `node` user, with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, and a single writable volume (`/data`) for the SQLite file; it has a healthcheck on `/healthz`.

## Deploying

```bash
cd <checkout of agent-dashboard on your server>
# .env (mode 600, gitignored) lives next to docker-compose.yml; create it from .env.example once.
git pull --ff-only && docker compose up -d --build
docker compose ps                         # wait for "healthy"
curl -fsS http://localhost:${PORT:-8787}/healthz
```

Data persists in the named volume `agent-dashboard-data`. Rollback: check out the previous commit and re-run `docker compose up -d --build`.

## Adding a skin

Rendering is a swappable layer. The data path is: **backend JSON/SSE -> `public/js/store.js` -> a view**. `public/js/views/mission-control.js` is the view; `public/js/main.js` wires the views together. **The pixel-art skin ships as that view plus `public/css/app.css`, the canvas engine in `public/js/office/`, `public/office/` (layout, sprite atlas), `public/js/avatar.js` (card portraits, drawn from the same atlas), and needs no backend changes**: there are no skin-specific fields or endpoints.

What the skin does: pixel borders and hard shadows (no rounded corners or blur), a limited palette in CSS variables, a system monospace font stack (no web fonts, which the CSP would block), a pixel progress track on the pipeline stepper, and an **office scene** (between the pipeline and the agent cards on desktop). The scene is decorative (`aria-hidden`); status is always also in each card's text badge. Each card also shows a small portrait of its character.

**Why a canvas.** An earlier version built the office from DOM nodes and CSS transitions. Free movement with pathfinding, reservable spots and correct Y-sorting of characters against furniture need per-frame positions, which CSS cannot express, so the office is now drawn on a `<canvas>`. It is still vanilla ES modules, no build step, no runtime dependencies and CSP-compatible (same-origin PNG and JSON, no inline scripts or `style` attributes; when the CSS size differs from the backing size it is set through CSSOM, which the CSP allows).

**Office scaling.** On tablet and desktop (>= 768 px) the office box is capped at 420 px tall (`--office-cap` in `app.css`), and the default fit (`1x`) uses the smaller of the width-fit and the height-fit, so the whole scene is visible; the zoom levels multiply that fitted width and the box pans inside itself. Below 768 px there is no cap and the box scrolls as described below. `canvasMetrics` fits the 1024x640 scene to a width. With `fit = width x dpr / 1024` and `s = floor(fit)`, a whole-number scale `s` is used when `s >= 1` and `s / fit >= 0.92` (crisp, at most 8% unused); otherwise the fractional `fit` is used (capped at 8). The backing store is a whole number of device pixels and is shown at backing / dpr CSS pixels, so the browser blits it 1:1; the scene is composed at native resolution and scaled once with smoothing off (and `image-rendering: pixelated`), so there are no seams. The canvas is never narrower than 640 CSS px (`MIN_CSS_WIDTH`, unchanged): in a narrower box (phones) it keeps 640px and the box scrolls horizontally inside itself, the page never does. The size is re-fitted live on a `ResizeObserver` notification, a `window` resize, and a device-pixel-ratio change (`dpr-watch.js`, a re-arming `resolution` media query); all listeners are removed in `destroy()`. `data-scale` on the canvas shows the effective scale.

**Layout shell and sections.** `public/index.html` holds the sections in a fixed DOM order (header, pipeline, agents, office, feed, costs, sessions, runs); `app.css` places them with a grid (mobile one column, tablet two-column agents, desktop with the office under the pipeline and agents beside the feed) and defines the spacing (`--space-1`..`--space-6`) and type (`--text-xs`..`--text-xl`) tokens. `public/js/collapse.js` wires the `button.sec-toggle[data-section]` inside each `<h2>`: it sets `aria-expanded` and the `hidden` attribute on the body named by `aria-controls` (the body stays in the DOM, so the views keep updating it) and persists `open` / `closed` in `localStorage` under `agent-dashboard.section.<id>`; storage failures fall back to the defaults. The pipeline section renders one panel per entry of `state.pipeline.runs`, in the server's order: a header button (repo, branch, `run …` plus the last 6 characters of the run id, `Attempt n of N`, status text; `aria-expanded` / `aria-controls`) over the stepper, substep chips, failed-gate, PR and deploy lines. A run waiting on user approval shows its own `role="alert"` banner inside its panel (there is no global approval banner). Panel collapse is kept in memory per run id and is not persisted; panels start open. The header run summary (`#run-summary`) still shows the last-emitting run (`state.pipeline.run`).

**Engine** (`public/js/office/`, the logic modules are pure and unit-tested under `node --test`):

| Module                          | Role                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout-format.js`, `layout.js` | format constants; validator (`validateLayout` returns every problem, `parseLayout` throws `LayoutError`)                                                                                                          |
| `grid.js`                       | walkable grid (walls plus blocking props), 4-neighbour A* `findPath`, `reachableFrom`                                                                                                                             |
| `spots.js`                      | spot reservation: an agent holds at most one spot, a spot has one holder, `reserveDesk` is stable per agent id                                                                                                    |
| `agent.js`                      | per-agent state machine driven by `setStatus`; dt-based movement in tiles per second; injectable RNG; `advance`/`nextWake` for reduced motion                                                                     |
| `behaviours.js`                 | the activity table (spot kind -> weight and steps), the pure idle scheduler `chooseNext`, `mulberry32` and the `?office-seed` parser                                                                              |
| `raf-once.js`                   | `scheduleOnce`: many `request()` calls in a frame run one callback (resize coalescing)                                                                                                                            |
| `sprite-format.js`, `roles.js`  | atlas frame names and the character pose table; `lookFor(id)` picks one of the eight looks (seven roles plus `fallback`)                                                                                          |
| `step-map.js`                   | pure: substep mapping (`{step: 'verify', substep: 'test'}` or legacy `{step: 'test'}` -> verify / test), per-character icon ids, `indicatorFor` (newest active substep wins) and the icon transition `iconFrames` |
| `atlas.js`                      | `parseAtlas` validates `atlas.json`; `loadAtlas()` loads JSON and PNG once, shared by the office and the portraits                                                                                                |
| `renderer.js`                   | offscreen tile layer, then props, chairs and characters Y-sorted by foot y (ties by id) in one pass; hybrid scale (`canvasMetrics`)                                                                               |
| `zoom.js`                       | zoom helpers (`ZOOM_LEVELS`, `nextZoom`, `parseStoredZoom`, `maxZoomFor`, centre maths, guarded storage read/write); `layout.js` also has `chooseLayout`                                                          |
| `loop.js`                       | one `requestAnimationFrame` at a time, dt clamped to 0.1 s, paused while the tab is hidden                                                                                                                        |
| `index.js`                      | `createOffice(root)` returning `addAgent(id)`, `setState(id, status)`, `removeAgent(id)`, `destroy()`                                                                                                             |

If the layout or the atlas cannot be loaded or fails validation, the office box shows the error text (and the console logs it) instead of a blank canvas; there is no flat-colour fallback. After the first frame the canvas also carries `data-atlas` (the frame count).

**Status mapping** (`stale` counts as idle; `mission-control.js` passes `a.stale ? 'idle' : a.status`):

| Status    | Behaviour                                                                                                     | State when settled                                    |
| --------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `idle`    | the scheduler picks an activity at a spot (or somewhere to stand), walks there, plays it, then picks the next | `sit sleep idle drink study check look water stretch` |
| `working` | reserves its own desk, walks there, sits, monitor on                                                          | `typing`                                              |
| `blocked` | stays at, or returns to, its desk with an alert bubble                                                        | `alert`                                               |
| `done`    | celebrates where it is for 3 s, frees its spot, then behaves as idle                                          | `celebrate`, then an activity                         |

**Idle activities** (`behaviours.js` is the single table; durations are drawn with the injected RNG):

| Spot kind  | Weight | Steps (seconds)                                                                        | Frames / overlay            |
| ---------- | ------ | -------------------------------------------------------------------------------------- | --------------------------- |
| beanbag    | 3      | `sit` 3-6, then `sleep` 10-25 with chance 0.6 (else keeps sitting for the whole dwell) | `sit`, `sleep`              |
| coffee     | 3      | `idle` 1-2 (at the counter), then `drink` 5-9                                          | `idle.up`, `drink` + steam  |
| whiteboard | 2      | `study` 6-12                                                                           | `reach` + chalk marks       |
| server     | 1.5    | `check` 4-8                                                                            | `reach` + blinking LED      |
| window     | 2      | `look` 6-14                                                                            | `idle` in the spot's facing |
| plant      | 2      | `water` 5-9                                                                            | `water` + falling drops     |
| wander     | 1.5    | `stretch` 2-3, then `idle` 1-3, standing on a free tile                                | `stretch`, `idle`           |

**Scheduler.** Candidates are every kind that has a free spot (never `desk`) plus `wander`. A kind's weight is its table weight times an anti-repeat factor (0.25 if it is the agent's last kind, 0.6 if it is among its last three) divided by `1 + 0.5 * occupants` (other agents in or heading for the zone). The spot is then the free one in the least crowded zone (ties by RNG) and is reserved atomically; if that fails the agent wanders. A wander tile avoids spot tiles and, best effort, other agents' tiles. The constants are exported from `behaviours.js`.

A status change mid-walk finishes the current tile step and re-paths from there; leaving a spot (for a desk, `done` or `removeAgent`) frees it at once. When there are more working agents than desks, the extra ones wait in the workspace and take a desk the moment one frees up.

**Reduced motion and hidden tabs.** With `prefers-reduced-motion: reduce` agents jump straight to their destination and hold the first frame of their pose, and no animation loop runs (a frame is drawn only when something changes; the media query is also watched live). Idle agents do not cycle activities (a static office must not hop around), but a celebration still ends: `sim.nextWake()` gives the time to the end of the celebrate and `index.js` keeps exactly one `setTimeout` for it (clamped to 0.25-30 s, cleared on hide, on leaving reduced mode and on `destroy()`), calling `sim.advance(elapsed)`. Desk waits are retried event-driven whenever a desk is released. While the tab is hidden the animation frame is cancelled; on return the first frame has dt 0, so nothing jumps.

**Removing agents.** `office.removeAgent(id)` (idempotent) frees the agent's spot and character; `mission-control.js` calls it, and removes the card, for every agent that disappears from `store.state.agents`.

**Resizing.** The resize observer, the window `resize` event and the pixel-ratio watcher share one fit per animation frame (`scheduleOnce`); `renderer.resize` does nothing when the backing and CSS sizes are unchanged, and `destroy()` releases the offscreen canvases.

**Zoom.** A toolbar above the office (`<div class="office-zoom" role="group" aria-label="Office zoom">`, outside the `aria-hidden` scene because it is interactive) has real buttons: `-` (Zoom out), the level, e.g. `1x` (Reset zoom to fit) and `+` (Zoom in). The level `z` is 1, 2, 3 or 4 and multiplies the container width passed to `canvasMetrics`, so 1 is the plain fit and higher levels make the canvas wider and taller than its box; the box (`.office`, `overflow: auto`, `max-height: 75vh` while the `zoomed` class is set) scrolls inside itself and the page never scrolls sideways. `-` is disabled at 1; `+` is disabled at 4, when the backing width would exceed 8192 px, and when the next level would not enlarge the picture (the renderer caps the scale at 8x). With focus in the toolbar, `+`/`=` zoom in, `-` zooms out and `0` resets (Enter and Space press the focused button). There is no wheel or pinch zoom (the wheel scrolls the page, or pans the box when zoomed). The visible centre is kept on a zoom change; resize and pixel-ratio changes keep the level. The level is stored in `localStorage` under `office.zoom` (every access is in a try/catch, so blocked storage just means zoom 1 after a reload; an invalid or out-of-range stored value is ignored). The office itself is decorative and not focusable, so there is no keyboard panning of a zoomed office. `data-zoom` is published on the canvas.

### Office layout override

The bundled layout is immutable (`/v/<hash>/office/layout.json`), so editing furniture would need a rebuild. Instead the server can serve a hand-edited file:

**Warning:** the file at `OFFICE_LAYOUT_PATH` is served as JSON to every authenticated dashboard user. It must contain only layout data, never secrets. The shape check is a safety net against pointing the variable at the wrong file, not a substitute for choosing the path carefully.

- Set `OFFICE_LAYOUT_PATH` to the absolute path of a layout JSON file (same format as `public/office/layout.json`). Unset (the default), nothing changes: `GET /api/office-layout` returns `404` and the bundled layout is used.
- `GET /api/office-layout` (and `HEAD`) sits behind the normal dashboard auth, takes no parameters (the query string is ignored; the path comes only from the env var) and re-reads the file on every request, so edit the file and reload the page; no restart. Responses: `200` JSON with `Cache-Control: no-store` and the usual security headers; `404` when unset, missing, unreadable or not a regular file (a directory or FIFO is not a file; a symlink to a regular file is followed, see below); `413` above 512 KiB; `422` when the content is not valid JSON, is not shaped like a layout, or cannot be serialised; `405` with `Allow: GET, HEAD` for other methods. Errors never contain the path or parser messages.
- The server does a cheap structural check (`version` 1, `tileSize` 16, integer `width`/`height` in 1..200, `layers.floor/walls/decor` arrays of `height` strings, and `zones/props/spots` arrays) and returns `422` otherwise, without echoing any of the content. The browser still does the full validation: it asks for the override first, runs the same `parseLayout` validator as for the bundled file, and on any failure (404, 422, bad JSON, wrong version, unreachable desk, unknown prop size, ...) writes a `console.warn` and draws the bundled layout; there is no error banner. Only if the bundled layout is invalid too does the readable error appear. The browser logs the one cheap `404` per page load when the override is not configured. The server constants live in `src/layout-shape.js`; a test keeps them in sync with `public/js/office/layout-format.js`.
- There is still no in-browser layout editor, and open tabs are not updated when the file changes.
- **Operator guidance:** put the layout in a dedicated directory that contains only that file, mount that directory read-only into the container, use an absolute path, and do not symlink to files elsewhere.
- **Symlinks:** symlinks are still followed. The shape check is what protects against leaking a non-layout target, and a symlink to another layout-shaped file is harmless. There is deliberately no `lstat`/`realpath` containment: the operator already controls the path, the variable is not request-controlled, containment would need a configured directory (which does not exist here), and `realpath`/`lstat` would add a new check-then-open window without protecting against anything the shape check does not. Still, avoid symlinks.
- **Deployment (operator step, not part of the code):** do not use `/data`: it is the writable volume that holds the SQLite database, so it is not layout-only. Instead keep a host directory outside the git checkout (for example `<host-config-dir>/office/`; any directory outside the checkout works) containing only `office-layout.json` (seed it from `public/office/layout.json`, mode 0644, directory 0755, because the container user is `node`), bind-mount it read-only and point the variable at it: `volumes: ["<host-config-dir>/office:/office-override:ro"]` and `environment: OFFICE_LAYOUT_PATH: /office-override/office-layout.json`. The compose file in this repo does not include the mount; the operator adds it and the variable, then recreates the container.

**Test hooks** (read-only, no secrets): the canvas carries `data-agents`, `data-states` (`id:state` pairs), `data-indicators` (`id:iconId` pairs of the current step icons), `data-spots` (`agentId:spotId` for agents holding a spot), `data-loop` (`running|static|paused`), `data-scale`, `data-zoom`, `data-atlas` and `data-fits` (the number of actual backing-store reallocations). `?office-seed=<integer>` in the page URL seeds the simulation RNG (mulberry32) so tests are repeatable; absent, it is `Math.random`. It changes nothing else.

### Merged agents (verify, review)

The orchestrator merges `test` + `styling` into one agent `verify`, and `security` + `code-review` into one agent `review`. Each merged agent is **one card, one office sprite and one stepper step**; the gate it is working on is a **substep**, which drives the card label and the icon (derived only from the pipeline events, nothing parsed from agent output, no model tokens):

| Stepper step | Substep       | Icon      | Card label    |
| ------------ | ------------- | --------- | ------------- |
| `verify`     | `test`        | flask     | `TEST`        |
| `verify`     | `styling`     | brush     | `STYLING`     |
| `review`     | `security`    | shield    | `SECURITY`    |
| `review`     | `code-review` | magnifier | `CODE REVIEW` |

- The stepper lists `verify` and `review` with their two substeps as chips; no gate name is a step. `emit-pipeline-event.sh` takes `--substep`, and still accepts the legacy gate names as `--step` (see "Pipeline events"). A `verify`/`review` entry with no active substep (a `single_role` run, or the agent active between gates) shows the text `VERIFY` / `REVIEW` on the card and no icon. A legacy run that has only seen substeps and has no explicit active parent is not listed in `active_steps` between gates.
- `GET /api/pipeline` and the SSE `pipeline` event carry `active_steps`: `[{run_id, repo, step, substep, ts, attempt}]`, every active parent step of every tracked feature run plus active `single_role` runs, newest first, at most 50; `step` is always a stepper step and `substep` a substep name or `null`. Nothing else (no summaries or URLs). The client defaults a missing field to `[]` and accepts the older `{step: 'test'}` shape (old servers).
- A character's indicator is the active entry with a substep and the newest `ts`, so parallel runs never hide each other (a parent-only entry is used when no entry has a substep); the card also lists the other active entries with their repo ("Also: ..."). Entries older than 10 minutes (the default `STALE_MINUTES`) are ignored on the client, and the server drops steps and runs silent for `PIPELINE_STALE_MINUTES` (default 60) from `active_steps` and marks them abandoned, so a crashed run cannot pin an icon. The icon shows only while the agent is `working` or `blocked`; `idle` and `done` clear it, and a card without step data looks as before.
- A change of icon plays a short transition (0.4 s: the old icon rises and fades, the new one drops in) on the existing render clock; with `prefers-reduced-motion` it swaps instantly, and the substep chips have no animation of their own.
- **Legacy names.** The pipeline names `test`, `styling`, `security` and `code-review` map to `verify` / `review` plus a substep and never create a card (see "Untracked agents"); the merged cards carry `data-step` (`verify`/`review`) and `data-substep`.
- **Add an indicator icon.** Draw an 8 x 8 frame in `scripts/art/props.js` (add `icon.<id>` to `PROPS`), add the id to `INDICATOR_IDS` in `sprite-format.js`, map it in `INDICATORS` (and `STEP_TO_CHARACTER` for a new legacy gate name) in `step-map.js`, run `node scripts/build-office-atlas.js`, then `npm test`.

### Untracked agents

The agents `test`, `styling`, `security` and `code-review` are retired (the constant `RETIRED_AGENTS` in `src/state.js`); `verify` and `review` replace them. The name `unknown` (the hook's name for a top-level session that matches no role, such as a Claude session in another repo) is handled the same way, through `UNTRACKED_AGENTS = [...RETIRED_AGENTS, 'unknown']`. `helper` is real subagent activity and keeps its card.

- **Accepted:** hook events with `agent` set to a retired name or `unknown` still return `201` and are stored, so fail-open hooks never see an error. Legacy pipeline step names are still accepted and mapped to verify / review plus a substep.
- **Dropped:** a retired name or `unknown` never gets a card or an office character, does not count toward `MAX_AGENTS`, and sends no SSE `agent` event. A retired name or `unknown` in `AGENTS` is ignored with a startup warning.
- **History:** existing rows are not rewritten or deleted; they age out under `RETENTION_DAYS`. The 48h replay at startup creates no retired or `unknown` cards, so an existing `unknown` card disappears on the first start after upgrading (open tabs drop it on reload). Cost and session views may still list the old names from historical events.

### Office art pipeline

`public/office/atlas.png` (one RGBA image) and `atlas.json` (the frame map `{version, image, width, height, tileSize, frames: {name: {x, y, w, h, ax, ay}}}`) hold every tile, prop and character frame. They are **generated and committed**; there is no build step for the app. Regenerate with `node scripts/build-office-atlas.js` (Node built-ins only, deterministic); a unit test fails when the committed files differ from the generator output.

- **Sources.** `art/kenney-roguelike-indoors/` holds the CC0 Kenney "Roguelike Indoors" sheet, unmodified, with a `SOURCE.txt` (URLs, retrieval date, sha256; a test pins the sheet's hash). The generator decodes it with a small PNG reader (`scripts/art/png.js`) and slices named tiles (tables, kitchen counter, framed pictures, the rug). The sheet has no usable floors or walls, so those and most props are drawn by us: `scripts/art/props.js` (tiles and props) and `scripts/art/characters.js` (the chibi looks), as code and string pixel maps. `ASSET-LICENSE` lists every file and says which frames are Kenney and which are custom.
- **Frame naming** (constants in `public/js/office/sprite-format.js`, also used by the generator and the tests): tiles `tile.<name>` (`wood carpet kitchen server grass rug wall-top wall-face`); props `prop.<type>.<w>x<h>[.<variant>]` (`prop.desk.2x1`, `prop.desk.2x1.lit`, `prop.beanbag.1x1.0`..`.3`), plus `prop.chair`; characters `char.<look>.<pose>.<dir>.<n>` and `char.<look>.portrait`. `ax, ay` is the offset in the frame of the bottom-left corner of a prop's footprint, or of a character's foot point (8, 18); sprites rise above it through `ay`.
- **Add a prop.** Draw it in `scripts/art/props.js` (add it to `PROPS`, or add a Kenney slice to `KENNEY_FRAMES` in the generator), add its type and sizes to `PROP_SPRITES` in `sprite-format.js` (`lit: true` for a second frame while in use, `variants: n` for n looks picked by position), use the type in `layout.json`, run `node scripts/build-office-atlas.js`, then `npm test`.
- **Change a role look or add a role.** Edit the look in `scripts/art/characters.js` (`LOOK_SPECS`: skin, hair, outfit and accent colours, hair style, accessory, body detail; accessories are pixel maps in `ACCESSORIES`). For a new role also add it to `ROLES` in `sprite-format.js`, then regenerate. The tests fail if a look lacks any pose frame or two looks are not visually distinct.
- **Fixed per role, plus a fallback.** Each of the seven roles has one look; every other id shares `fallback`. There is no per-id generation.
- **Portraits.** `createAvatar(id)` in `public/js/avatar.js` returns an `aria-hidden` 16 x 16 `<canvas class="avatar">` and draws `char.<look>.portrait` from the same atlas into it (smoothing off); CSS scales it to 48 x 48 with `image-rendering: pixelated`. If the atlas fails to load the canvas stays blank and the card text is unaffected.

**Assets and credits.** Tiles by Kenney (www.kenney.nl, CC0 1.0), plus original CC0 art; every asset, its source and its licence is listed in `ASSET-LICENSE`. The office design is inspired by [openclaw-pixel-agents-dashboard](https://github.com/jaffer1979/openclaw-pixel-agents-dashboard) (MIT); no code or art was copied from it.

Store contract (`createStore()` in `store.js`; `store.subscribe((state, what) => ...)`, where `what` is `all|agents|events|pipeline|connection`):

```
state.connection  'connecting' | 'live' | 'reconnecting'
state.agents[]    { id, status, task, since, run_started_ts, last_event_ts, tokens:{in,out}, cost_usd, unpriced_tokens, today, stale, ... }
state.events[]    newest first, bounded: { id, ts, agent, type, tool, summary, task, ... }
state.pipeline    { run: {steps[], status, abandoned, attempt, ...} | null, runs[] (one per panel; [run] or [] from an old server; abandoned flag defaulted), recent_runs[], activity_runs[] (abandoned flag defaulted), active_steps[] }
store.now()       server-corrected clock for elapsed timers
```

The `status` enum is stable and documented above; the skin mapping is `working` -> walk to desk, `idle` -> wander between zones, `blocked` -> alert, `done` -> celebrate.

## Browser (end-to-end) tests

`npm test` is fast and needs no browser. `npm run test:e2e` drives the real UI in headless Chromium through Playwright (`@playwright/test`, a devDependency only; pinned to 1.62.1, so `npm ci --omit=dev` and the production image never see it).

```bash
npm ci
npm run test:e2e
```

- The suite starts the app itself (`src/index.js`) on a free localhost port with a scratch SQLite DB in the OS temp dir, random hex tokens and `COOKIE_SECURE=false`, and removes everything afterwards, even on failure. No `.env` or running instance is needed.
- Browsers: Playwright looks in `~/.cache/ms-playwright` (or `$PLAYWRIGHT_BROWSERS_PATH`). Version 1.62.x expects Chromium build `chromium-1234` / `chromium_headless_shell-1234`, which is what this machine already caches; nothing is downloaded. On a fresh machine run `npx playwright install chromium` once (large download) or point `PLAYWRIGHT_BROWSERS_PATH` at an existing cache.
- The `layout shell` tests cover the structure: section DOM order, no horizontal scroll at 375 / 768 / 1280 / 1920 px, the 1440 px content width, header and pipeline height limits, the stepper in one row / 4 + 4 / 2x4, substep chips inside their step, the sticky header and run summary, collapse defaults, toggling, persistence and blocked storage, the always-visible period select, and the 420 px office box.
- The `panels` tests cover the second redesign step: agent cards at most 150 px tall at 1280 px with a closed-by-default Details button (`aria-expanded` / `aria-controls`), the always-visible cost tiles matching `/api/costs`, zero-usage days folded into one line, the sessions summary (count, shown as `50+` when the fetch limit is reached, and the latest 3), one-line feed rows with a `title` and a focusable list, empty states (title plus one line), no horizontal scroll with costs and sessions expanded at all four widths, and `scroll-padding-top` keeping keyboard focus clear of the sticky header.
- The `multiple panels` tests cover the pipeline panels: five parallel runs emitted through the real event path show five panels with their own repo, branch and attempt, the approval banner appears only in the waiting run's panel, collapsing one panel hides its body and keeps the others open (`aria-expanded`, kept across re-renders, nothing in `localStorage`), and no horizontal scroll with five panels at 375 / 768 / 1280 / 1920 px. Tests that need an empty pipeline use a private app instance (`isolatedServer` / `isolatedPage`).
- Covers login/logout, cards and badges, live feed and filter, pipeline stepper (attempts, failed gate, approval banner, deploy outcomes), XSS-as-text, 375px phone layout with no horizontal scroll, and fails on any console error, page error or CSP violation.
- Screenshots (`desktop.png`, `phone.png`) are written to the gitignored `e2e-artifacts/`; failure artifacts go to `test-results/`.

### Panel layout notes

- Collapse state is stored per section in `localStorage` under `agent-dashboard.section.<id>` (`open` or `closed`; costs and sessions default to closed). The agent card Details disclosure is deliberately not persisted: it is closed on every load.
- Costs and sessions each have an always-visible summary (`#costs-summary`, `#sessions-summary`) outside the collapsible body; the full tables are in the body (`#costs`, `#sessions`).
- The live feed list (`#feed`) is focusable (`tabindex="0"`). Beside the agents (>= 1200 px) it fills the agents row height (200 to 560 px) and its type column is hidden (still in the DOM and in the row `title`); below that it is capped at 420 px.
- Known limitation: at >= 1200 px the tab order follows the DOM order (agents, office, feed) and differs from the visual order (office above agents).
- No screenshots are linked from this README.

## Layout

```
src/        config, redaction, event validation, pricing + cost, SQLite store, derived state, HTTP server
public/     static UI (index.html, css/, js/store.js, js/views/, js/office/ canvas engine, office/ layout.json + atlas.png/json)
scripts/    hook.js (Claude Code hook), emit-pipeline-event.sh, demo.js, build-office-atlas.js, art/ (atlas sources: png, raster, props, characters), lib/hook-lib.js
art/        third-party art input of the atlas (Kenney CC0 sheet); not served, not in the Docker image
test/       node:test suites (npm test); tests create temp dirs with tempDir(t) from test/helpers.js, and npm test fails on leftovers
e2e/        Playwright browser tests (npm run test:e2e)
```

Test-only variable: `AGENT_DEFINITIONS_DIR` (optional) points at a directory of role `.md` files; `test/office-art.test.js` then checks that the role list matches the file names, and skips that check when it is unset.
