# agent-hub

A private web hub for talking with a small set of AI agents. Each agent is a glowing glass orb that expands, on click, into a hologram half figure. A side rail lists the agents (Arshwyn, the orchestrator, then Hephaestus, Themis, Janus, Atlas, Plutus, Apollo, Iris, Dionysus); a chat panel sits under the stage.

**Status: chat for eight agents.** The roster, the 3D bodies, routing and single-owner sign-in work, and text chat works for Arshwyn (the orchestrator) and for Hephaestus, Themis, Janus, Atlas, Plutus, Iris and Dionysus through a small gateway on the host that runs Claude Code, each agent with its own conversations and the access its agent file gives it (`docs/ISOLATION.md` has the table). Only one reply runs at a time across all agents; the rail marks the one that holds it. Health data is fenced in two layers: every web profile denies the health connectors and starting Apollo as an agent, and a host guard-hook group (a heuristic, not a sandbox) must close what the shell and file tools could still reach, such as Apollo's memory folders or a nested `claude` start (see `docs/ISOLATION.md`). A reply keeps running, and is saved, if the browser tab is closed; Stop or the host kill switch ends it. A run that fails before doing anything is retried once; a run that used a tool is never retried (see `docs/ISOLATION.md`). Apollo is never proxied: its card links out to its own chat app. **Web chat is equivalent to remote control of the infrastructure for anyone who holds a valid owner session or who compromises the hub container (which can reach the gateway socket); the classifier and the host guard narrow this, they are not a sandbox. Read [`docs/ISOLATION.md`](docs/ISOLATION.md) before enabling chat: a web chat run has the agent's own tool access (the pilot has the orchestrator's) and uses the same permission mode (`auto`) as the interactive session, which lets it read files outside the workspace and edit files inside it without a prompt.** A send that is refused (another reply is running, rate limit, chat switched off, service not reachable) shows a plain notice, stores nothing and keeps your text in the box. See [`docs/DESIGN.md`](docs/DESIGN.md) for the look and the rules behind it.

- Node 24, plain `http` server with one runtime dependency (`better-sqlite3`, for the chat history, installed from its prebuilt binary), no frontend framework, no build step, no CDN. The browser needs WebGL 2 (otherwise the stage shows the text "3D view needs WebGL 2").
- Sign-in is Cloudflare Access only: the server verifies the `Cf-Access-Jwt-Assertion` JWT against the team's published keys, checks issuer, audience and expiry, and allows exactly one email. There are no passwords or sessions of its own. Everything except `/healthz` and `/event` requires it, and it fails closed.
- `/healthz` is open. `POST /event` is a stub that reads the body, stores nothing and returns 204, so hooks configured elsewhere for the old dashboard do not error.
- The app logs one line per request (time, method, route pattern, status, duration, response bytes) and nothing else: no query string, headers, cookies, tokens, bodies or client address; `/healthz` is not logged.
- The hub and the gateway must run on the same host (a unix socket cannot cross hosts); the gateway is a systemd user unit, see `docs/DEPLOY.md`.
- Default port: **8787**.

## Apollo in the hub view

Apollo is never run or proxied by the hub. With `APOLLO_EMBED=1` the Apollo pane shows the separate Apollo chat app in an iframe, next to Apollo's orb; with it off (default) the pane is a link-out button. The app inside the frame is another origin with its own Access sign-in, history and runs, so this page cannot read it and never fetches, stores or logs anything from it. The frame is sandboxed, sends no referrer and is created only while Apollo is selected. The Apollo app sends two content-free messages (ready, and idle/thinking/speaking) that move the orb; they are accepted only from the configured origin and the frame's own window and kept in memory. If no ready message arrives within 8 seconds (signed out, or framing not allowed by the Apollo app), the pane shows a sign-in hint with a link that opens Apollo in its own tab. Sign in there first; the frame works while that session lasts. See `docs/ISOLATION.md` ("Apollo in the hub view").

## Configuration

Copy `.env.example` to `.env` and fill it in (it is gitignored).

| Variable             | Required | Meaning                                                                                            |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | yes      | Hostname of the Cloudflare Access team, no scheme                                                  |
| `ACCESS_AUD`         | yes      | Audience tag of the Access application in front of this app                                        |
| `OWNER_EMAIL`        | yes      | The single allowed email                                                                           |
| `PORT`               | no       | Listen port (default 8787)                                                                         |
| `HOST`               | no       | Bind address (default 127.0.0.1; the image sets 0.0.0.0)                                           |
| `BIND_ADDR`          | no       | Address compose publishes the port on (default 127.0.0.1)                                          |
| `APOLLO_CHAT_URL`    | no       | https link-out for the Apollo card (no credentials in the URL); empty hides it                     |
| `APOLLO_EMBED`       | no       | `1` shows the Apollo chat app in a frame in the Apollo pane (needs `APOLLO_CHAT_URL`; default off) |
| `DEV_AUTH_BYPASS`    | no       | `1` skips Access for local development only                                                        |
| `GATEWAY_SOCKET`     | no       | Absolute path of the chat gateway's unix socket; unset means chat is offline                       |
| `DB_PATH`            | no       | Chat history database (default `./data/hub.db`)                                                    |
| `CHAT_DISABLED`      | no       | `1` is the app-side kill switch for web chat                                                       |
| `CHAT_MAX_PER_MIN`   | no       | Messages per minute across all chats (default 6)                                                   |

`DEV_AUTH_BYPASS=1` is accepted only when `NODE_ENV` is explicitly `development` or `test` (case and spaces ignored; unset or anything else is refused) and `HOST` is a loopback address; otherwise the server refuses to start. With it on, only requests from the local machine are served (a request carrying `X-Forwarded-For`, `Forwarded` or any `Cf-*` header is refused, as it came through a proxy or tunnel) and a warning is logged at startup. Never set it on a deployment.

## Run

```bash
npm install
# local development, no Access:
NODE_ENV=development DEV_AUTH_BYPASS=1 npm start   # http://127.0.0.1:8787
# or with Access configured in .env:
npm start
```

With Docker, `docker compose up -d --build` builds the image and publishes the port on `BIND_ADDR`; put it behind a Cloudflare Access application (a tunnel or reverse proxy) so requests carry the JWT header. The compose file refuses to start without the Access variables and the chat ones (`HUB_UID`, `HUB_GID`, `GATEWAY_SOCKET_DIR`, `HUB_DATA_DIR`); the host steps are in [`docs/DEPLOY.md`](docs/DEPLOY.md).

Add `?perf` to the page URL to show the frame-time readout on the stage; `?yaw=`, `?pitch=`, `?roll=`, `?scale=`, `?dy=` and `?god=<id>` tune a model's fit while developing (values are clamped).

## Project layout

- `src/` server, config, the Access verifier, the chat API (`chat.js`), the CSRF check, the gateway client, the stream mapper (the only code that decides what reaches the browser) and the history store.
- `gateway/gateway.js` the host-side chat gateway (dependency-free): fixed profile table for eight agents (the pilot as the main session, seven as `--agent`), fixed command line (permission mode `auto`, never a bypass), a drift check of each agent file, denied health connectors and Apollo sub-agent (`HUB_DENY_TOOLS` in the gateway environment, see `docs/DEPLOY.md`), one run at a time, kill switch, audit log. `docs/host/` holds its systemd unit and environment sample.
- `public/` the app: `index.html`, `css/app.css`, `js/app.js` (shell and routing), `js/hub.js` (the 3D viewer), `js/apollostate.js` (the filter for the framed Apollo app's state messages), `roster.json` (the one roster file), `models/` (the eight generated figures) and `vendor/` (a three.js subset bundle with its licence and rebuild notes).
- `docs/DESIGN.md` the design identity. `docs/DEPLOY.md` how to run the app and the gateway. `docs/ISOLATION.md` what web chat can do, the threat model and the kill switch. `ASSET-LICENSE` lists every asset and its licence.
- `scripts/hook.js` a no-op kept so existing hook entries on the host keep working.

## Tests

```bash
npm test        # node:test, no network
npm run lint    # eslint and prettier --check
```

The tests cover config validation, the Access verifier (signature, issuer, audience, expiry, email, key caching, fail closed), the routes and headers, the roster, the `/event` stub and the removal of the old dashboard, and for chat: the gateway's validation, fixed command line, kill switch, one-run limit, timeouts and audit log (against a fake `claude` script, no model), the stream mapping, the page's DOM-free stream logic (including the notice for every refused send), request logging, CSRF, input limits, rate limit and history. The history tests that load `better-sqlite3` need Node 22 or later and are skipped on older Node; the rest use an in-memory store with the same contract.

## Licence

Code: MIT, see `LICENSE`. Generated models and other assets: see `ASSET-LICENSE`.
