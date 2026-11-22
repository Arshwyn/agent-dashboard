# Deploying the hub with web chat

Two parts run on the host that has Claude Code (the same host): the **hub app** (a container, from this repository's compose file) and the **chat gateway** (a small Node script, a systemd service). The app talks to the gateway over a unix socket. Read [`ISOLATION.md`](ISOLATION.md) first: web chat gives the browser the orchestrator's own tool access.

Every value below is a placeholder. Real paths, users, hostnames and the Access settings come from the host's own files and `.env`, never from this repository.

## What you need

- **One host for both parts.** The gateway listens on a unix socket and the app container mounts that socket's directory, so the hub **must run on the same host as the gateway** (a unix socket cannot cross hosts), as `apollo-chat` does. A hub on another host cannot reach the gateway.
- Node 20 or later on the host for the gateway (it has no dependencies), and Claude Code with `--permission-prompts` (cli-reference and the "Turn off permission prompts in unattended runs" section of the headless page at code.claude.com/docs/en; it needs 2.1.259 or later) and `--permission-mode auto` (permission-modes page; auto mode needs a supported model), logged in as the service user.
- Docker with the compose plugin for the app. The image needs no build tools: `better-sqlite3` ships a prebuilt binary and `.npmrc` stops install scripts, so `npm ci` compiles nothing.
- A Cloudflare Access application in front of the app, one allowed email, short session.
- The orchestrator's workspace directory (the working directory of every web run), and its web-run guard hook in place, including the group that refuses Apollo's memory folders and `claude` launches from the shell (see "Host prerequisites for health separation" in [`ISOLATION.md`](ISOLATION.md)).

## 1. Host: the gateway

The gateway runs as a **systemd user unit** of the service user (the user that owns the Claude Code login), not as a system unit: there is no `User=` or `Group=`, the install target is `default.target`, and it is managed with `systemctl --user`. The gateway, the socket and the hub container all use that one uid and gid.

1. Create three private directories owned by the service user:
   - the **socket directory**, `mkdir -m 700 /path/to/hub-socket`: holds only `gateway.sock` (mode 0600) and is the **only** directory the container mounts;
   - the **gateway directory**, `mkdir -m 700 /path/to/hub-gateway`: holds `gateway.env` (mode 0600), the audit log and the kill-switch file. **Never mount it, and never put `gateway.env` in the socket directory**: the socket directory is bind-mounted into the container, so anything in it is visible there;
   - the **data directory**, `mkdir -m 700 /path/to/hub-data`: the history database.
     The gateway refuses to start if one of these paths exists but is not a directory owned by the service user, and it only replaces an old socket file that nothing answers on (never a regular file, directory or symlink, and never a socket another gateway may be using: anything but a clear "connection refused" counts as live; the probe and the unlink are two steps, which is accepted because one systemd unit starts the gateway); a symlinked directory is refused too. Keep the socket path at 100 bytes or fewer.
2. Copy [`host/gateway.env.sample`](host/gateway.env.sample) to `/path/to/hub-gateway/gateway.env` (mode 0600) and set `WORKSPACE_DIR`, `GATEWAY_DATA_DIR`, `GATEWAY_SOCKET` (in the socket directory), `HUB_DENY_TOOLS` and, because a service has a short `PATH`, an absolute `CLAUDE_BIN`. `HUB_DENY_TOOLS` is required: a comma-separated list with one `mcp__<connector>` (or `mcp__<connector>__*`) entry for every connector that carries health data, with the real names as the host's tool list shows them. `Agent(apollo)` is always denied on top. While the list is empty no agent starts (the page says chat is not set up), and an entry of another shape stops the gateway at start.
3. Lingering must be on for the service user so the unit survives logout and starts at boot: an administrator runs `loginctl enable-linger <service-user>` once (check with `loginctl show-user <service-user> --property=Linger`).
4. Copy [`host/agent-hub-gateway.service`](host/agent-hub-gateway.service) to `~/.config/systemd/user/` of the service user, set the `EnvironmentFile` and the `ExecStart` path to the checkout, then as that user `systemctl --user daemon-reload` and `systemctl --user enable --now agent-hub-gateway`.
5. Check: `journalctl --user -u agent-hub-gateway` shows a `listening` line, and `ls -l` shows `gateway.sock` with mode `srw-------` owned by the service user.

Resource limits: the unit template sets `MemoryMax=1500M` and `TasksMax=512` as recommended defaults for a small host; raise them if legitimate runs hit them. `NoNewPrivileges=yes` is optional and left out of the template on purpose: it blocks `sudo` and other setuid helpers the orchestrator's tools may use.

Optional systemd hardening is deliberately not in the unit and has not been verified with Claude Code: see "Optional systemd hardening (unverified)" in [`ISOLATION.md`](ISOLATION.md).

**Guard hook registration.** The guard hook entry in the user-level settings should carry the failure-handling field set to fail closed, like the existing secret guard, so that a crash, timeout or error in the hook denies the call instead of allowing it. Check this after changing the hook (the exact field name is in the public Claude Code hooks documentation). What the guard covers, and what it does not, is in [`ISOLATION.md`](ISOLATION.md).

**Project MCP servers.** A web run loads the workspace's project MCP servers just as a terminal session does. A server that binds a fixed port will conflict with the interactive session running at the same time. Give such a server a way to tell a web run apart (it can check `HUB_CHAT_RUN=1`) and start as an idle stub with no capabilities in that case; the workspace's watchdog channel server does this.

How the gateway reaches the orchestrator: it starts `claude` with the workspace as the working directory, as the service user, so the workspace's own `CLAUDE.md`, settings, permission rules, hooks and connectors load exactly as in a terminal session, and the run uses the same permission mode (`auto`) as the interactive session. That mode lets a run read files outside the workspace and edit files inside it without a prompt: before enabling chat, read the blast-radius section of [`ISOLATION.md`](ISOLATION.md) and decide on `permissions.blockReadsOutsideWorkingDirectories` and explicit deny rules for sensitive paths. The pilot runs as the workspace's **main session** (no `--agent` flag), so no agent file or link has to be installed for it. The other seven agents run as `--agent <id>` and need their agent file in the workspace's `.claude/agents/` directory exactly as it is today: the gateway reads each file's tool-affecting keys at the start of a run and refuses the run (`profile_mismatch`) when they differ from the table in [`ISOLATION.md`](ISOLATION.md). Changing an agent's tools therefore means changing the table in the same release. Leave `GATEWAY_MODEL` unset so each agent file's `model` applies. The run's environment is only `PATH`, `HOME`, `LANG`, `HUB_CHAT_RUN=1` and `HUB_RUN_ID`; a hook or setting that needs another variable must read it from a file, not from the gateway's environment.

## 2. Host: the app

1. Copy `.env.example` to `.env` next to `docker-compose.yml` and fill in the Access values and the chat variables:
   - `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` as before.
   - `HUB_UID` and `HUB_GID`: the service user's ids. The container runs as them because the socket is mode 0600.
   - `GATEWAY_SOCKET_DIR=/path/to/hub-socket`: mounted read-only at `/gateway`; the app connects to `/gateway/gateway.sock`.
   - `HUB_DATA_DIR=/path/to/hub-data`: mounted at `/data`; the history database is `/data/hub.db`.
2. **Check file modes after checkout.** The container runs as the service user and reads the deploy tree. A checkout made under a strict umask (for example `077`) can leave the tree unreadable to the container user: the container then crash-loops with `EACCES`. After a pull or fresh checkout, confirm the tree is readable (`ls -l`, and a normal umask such as `022` for the checkout), then build.
3. `docker compose up -d --build`, then check the container health and `curl http://<BIND_ADDR>:<PORT>/healthz` using the address compose publishes on (`BIND_ADDR`, default `127.0.0.1`, and `PORT`, default 8787 from `.env`); a loopback address will not answer if the port is published on another one.
4. The app writes one log line per request to the container log: time, method, route pattern (ids reduced, for example `/api/chats/:id`), status, duration and response bytes, and nothing else (no query string, headers, cookies, tokens, bodies or client address). `/healthz` is not logged.
5. The tunnel or proxy in front must pass the original `Host` header through (the CSRF check compares it with the `Origin` header) and must not buffer or cut `text/event-stream` responses; the app sends a comment line every 15 seconds so an idle-timeout proxy keeps the stream open.
6. In the Access application: one policy, one allowed email, a short session. The app checks the Access token itself, so a misconfigured policy still fails closed.

The app container must run with `restart: unless-stopped` (the compose file sets it): if uncaught errors loop (more than 5 in 60 seconds) the app logs the error name and exits non-zero, and the restart policy brings it back.

## Apollo in the hub view (optional)

Set `APOLLO_CHAT_URL` to the Apollo app's address and `APOLLO_EMBED=1`, then rebuild the container. Prerequisites: the Apollo app is deployed with its `EMBED_ANCESTOR` set to this hub's origin (otherwise the frame stays blank and the pane shows the fallback), and the owner has signed in to the Apollo app in this browser (its Access application and session are separate from the hub's and last as long as that application's session duration). Both addresses must be on the same site (sibling subdomains of one registrable domain) so the Access cookie is sent inside the frame; confirm this read-only before enabling. Neither Access application changes. Verify: open Apollo's pane, the orb should follow replies; sign out of the Apollo app and the pane should show the sign-in hint within 8 seconds.

## Kill switch

- **Instant, no restart:** `touch /path/to/hub-gateway/DISABLED` (the gateway directory, outside the container) refuses every new web run **and ends a run in progress** within about a second (`KILL_POLL_MS`, default 1000; SIGINT, then SIGTERM, then SIGKILL on the run's process group). The page shows a notice and "switched off during this reply". `rm` the file to turn chat back on.
- **Restart-based:** `GATEWAY_DISABLED=1` in `gateway.env` (restart the service), or `CHAT_DISABLED=1` in the app's `.env` (recreate the container).
- `CHAT_DISABLED` (app side) only refuses new sends; use the gateway flag to cut a running reply. Stop on the page, stopping the gateway unit, or the app going away also end a run.
- Closing the browser tab does **not** end a run: the reply finishes and is saved. Stop it from the page, or use the kill switch.

## Logs, data and retention

| What                                                                           | Where                                    | Notes                                                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit log (one JSON object per run with agent and profile, no message content) | `/path/to/hub-gateway/audit.log`         | Mode 0600. Appended forever: rotate it (logrotate `copytruncate`, weekly, keep a few weeks) or prune it on a schedule.                         |
| Gateway journal                                                                | `journalctl --user -u agent-hub-gateway` | Same metadata lines. No prompts, replies or tool inputs.                                                                                       |
| Conversation history                                                           | `/path/to/hub-data/hub.db` (+ `-wal`)    | Plain text of the owner's chats, mode 0600. Back up with the host's other private data; copy it with the app stopped or use `sqlite3 .backup`. |
| Claude Code sessions                                                           | the service user's Claude Code state     | A hub conversation id is the Claude session id. Deleting a chat in the hub does not remove this file.                                          |

## Smoke test

1. Open the hub through Access, choose Arshwyn: the input is enabled and the page says nothing about being offline, and the access line under the name is shown.
2. Send a short message: the orb shows thinking, then speaking while text streams, then idle. The audit log gained one line.
3. Send two messages quickly from two tabs: the second is refused as busy. The page shows "Another reply is still running. Wait for it to finish or press Stop.", keeps your text in the box, and leaves no empty reply bubble.
4. Permission parity: ask the pilot to run Atlas (or any subagent) for read-only host checks such as listing a directory and showing uptime. They must run, not be denied. If they are denied, check the session transcript on the host and the workspace rules before blaming the hub.
5. One read-only question per agent, one at a time: Hephaestus (list the repos it can see), Themis (what tools it has), Janus (the same), Atlas (uptime of a host through its wrapper), Plutus, Iris and Dionysus (a question they can answer without touching an account). Each answers as itself, the rail shows "running" while it works, and each agent's chat list is separate. Ask Themis or Janus to edit a file: it has no edit tool and says so. Ask any agent to read a health connector or to start Apollo as an agent: the call is denied (the deny list). Then confirm the host guard-hook group: ask a web agent to read a file in the Apollo memory folders, and ask it to launch `claude` from the shell. Both must be refused. If either works, do not use chat with those agents until the hook group is fixed (see "Host prerequisites for health separation" in [`ISOLATION.md`](ISOLATION.md)); it is a heuristic, so also try a differently written form once.
6. Edit an agent file's `tools` line on a scratch copy of the workspace (or temporarily): the next send to that agent fails with the profile message and the audit log shows `profile_mismatch`; restore the line.
7. Start a longer reply, then `touch DISABLED`: the reply stops within a couple of seconds with "switched off", and further sends are refused; `rm DISABLED` restores it.

## Rollback

- **App:** redeploy the previous image tag (`IMAGE_TAG`) with `docker compose up -d`. A rollback does not touch the history database.
- **Gateway:** `systemctl --user disable --now agent-hub-gateway`, remove the unit, and delete the socket and gateway directories if they are no longer wanted. Without a gateway the app still serves the roster and bodies and says chat is offline.
- **Fastest stop when something looks wrong:** the kill switch above, then stop the service.

## Upgrading

Pull, rebuild the app (`docker compose up -d --build`), `systemctl --user restart agent-hub-gateway`. The app re-resolves the socket on every request, so a gateway restart only fails the run that was in flight.
