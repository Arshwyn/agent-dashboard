# Deploying the hub with web chat

Two parts run on the host that has Claude Code: the **hub app** (a container, from this repository's compose file) and the **chat gateway** (a small Node script, a systemd service). The app talks to the gateway over a unix socket. Read [`ISOLATION.md`](ISOLATION.md) first: web chat gives the browser the orchestrator's own tool access.

Every value below is a placeholder. Real paths, users, hostnames and the Access settings come from the host's own files and `.env`, never from this repository.

## What you need

- Node 20 or later on the host for the gateway (it has no dependencies), and Claude Code **v2.1.259 or later** (the `--permission-prompts` flag does not exist before it), logged in as the service user.
- Docker with the compose plugin for the app. The image needs no build tools: `better-sqlite3` ships a prebuilt binary and `.npmrc` stops install scripts, so `npm ci` compiles nothing.
- A Cloudflare Access application in front of the app, one allowed email, short session.
- The orchestrator's workspace directory (the working directory of every web run).

## 1. Host: the gateway

1. Pick a service user that already owns the Claude Code login and can read the workspace. The gateway, the socket and the hub container all use this one uid and gid.
2. Create the gateway directory, private to that user: `mkdir -m 700 /path/to/hub-gateway`. The socket (`gateway.sock`, mode 0600), the audit log and the kill-switch file live here by default. Keep the socket path at 100 bytes or fewer.
3. Create the data directory for the history database, owned by the same uid and gid: `mkdir -m 700 /path/to/hub-data`.
4. Copy [`host/gateway.env.sample`](host/gateway.env.sample) to `/path/to/hub-gateway/gateway.env` (mode 0600) and set `WORKSPACE_DIR`, `GATEWAY_DATA_DIR` and, because a systemd service has a short `PATH`, an absolute `CLAUDE_BIN`.
5. Copy [`host/agent-hub-gateway.service`](host/agent-hub-gateway.service) to `/etc/systemd/system/`, set `User`, `Group`, the `EnvironmentFile` and the `ExecStart` path to the checkout, then `systemctl daemon-reload` and `systemctl enable --now agent-hub-gateway`.
6. Check: the journal shows a `listening` line, `ls -l` shows `gateway.sock` with mode `srw-------` owned by the service user.

How the gateway reaches the orchestrator: it starts `claude` with the workspace as the working directory, as the service user, so the workspace's own `CLAUDE.md`, settings, permission rules, hooks and connectors load exactly as in a terminal session. The pilot runs as the workspace's **main session** (no `--agent` flag), so no agent file or link has to be installed for it. The run's environment is only `PATH`, `HOME`, `LANG`, `HUB_CHAT_RUN=1` and `HUB_RUN_ID`; a hook or setting that needs another variable must read it from a file, not from the gateway's environment.

## 2. Host: the app

1. Copy `.env.example` to `.env` next to `docker-compose.yml` and fill in the Access values and the chat variables:
   - `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` as before.
   - `HUB_UID` and `HUB_GID`: the service user's ids. The container runs as them because the socket is mode 0600.
   - `GATEWAY_SOCKET_DIR=/path/to/hub-gateway`: mounted read-only at `/gateway`; the app connects to `/gateway/gateway.sock`.
   - `HUB_DATA_DIR=/path/to/hub-data`: mounted at `/data`; the history database is `/data/hub.db`.
2. `docker compose up -d --build`, then check `curl http://127.0.0.1:8787/healthz` and the container health.
3. The tunnel or proxy in front must pass the original `Host` header through (the CSRF check compares it with the `Origin` header) and must not buffer or cut `text/event-stream` responses; the app sends a comment line every 15 seconds so an idle-timeout proxy keeps the stream open.
4. In the Access application: one policy, one allowed email, a short session. The app checks the Access token itself, so a misconfigured policy still fails closed.

## Kill switch

- **Instant, no restart:** `touch /path/to/hub-gateway/DISABLED` refuses every new web run (the page shows a notice); `rm` the file to turn chat back on.
- **Restart-based:** `GATEWAY_DISABLED=1` in `gateway.env` (restart the service), or `CHAT_DISABLED=1` in the app's `.env` (recreate the container).
- A running reply is not cut by the flag. Stop it from the page, or stop the gateway service, which ends the run (so does the app going away).

## Logs, data and retention

| What                                                    | Where                                 | Notes                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit log (one JSON object per run, no message content) | `/path/to/hub-gateway/audit.log`      | Mode 0600. Appended forever: rotate it (logrotate `copytruncate`, weekly, keep a few weeks) or prune it on a schedule.                         |
| Gateway journal                                         | `journalctl -u agent-hub-gateway`     | Same metadata lines. No prompts, replies or tool inputs.                                                                                       |
| Conversation history                                    | `/path/to/hub-data/hub.db` (+ `-wal`) | Plain text of the owner's chats, mode 0600. Back up with the host's other private data; copy it with the app stopped or use `sqlite3 .backup`. |
| Claude Code sessions                                    | the service user's Claude Code state  | A hub conversation id is the Claude session id. Deleting a chat in the hub does not remove this file.                                          |

## Smoke test

1. Open the hub through Access, choose Arshwyn: the input is enabled and the page says nothing about being offline.
2. Send a short message: the orb shows thinking, then speaking while text streams, then idle. The audit log gained one line.
3. Send two messages quickly from two tabs: the second is refused as busy.
4. `touch DISABLED`: the page shows the switched-off notice and a send is refused; `rm DISABLED` restores it.

## Rollback

- **App:** redeploy the previous image tag (`IMAGE_TAG`) with `docker compose up -d`. A rollback does not touch the history database.
- **Gateway:** `systemctl disable --now agent-hub-gateway`, remove the unit, and delete the gateway directory if the socket is no longer wanted. Without a gateway the app still serves the roster and bodies and says chat is offline.
- **Fastest stop when something looks wrong:** the kill switch above, then stop the service.

## Upgrading

Pull, rebuild the app (`docker compose up -d --build`), `systemctl restart agent-hub-gateway`. The app re-resolves the socket on every request, so a gateway restart only fails the run that was in flight.
