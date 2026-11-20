# Isolation and blast radius

This page says plainly what web chat can do, what it cannot, and what protects it. Read it before enabling chat on a host.

## The plain statement

**The pilot agent (Arshwyn, the orchestrator) runs through the hub with the orchestrator's own tool access.** A web chat run is the orchestrator's main session: the same workspace, the same instructions, the same settings, the same permission rules and hooks, and every tool and connector that session has. Whatever those rules let it do from a terminal, they let it do from the web.

So **a compromised web session equals control of whatever the orchestrator can reach**, including the infrastructure it can administer. The hub adds no extra sandbox around the agent. What the hub adds is a narrow, authenticated, rate-limited door and the mitigations below. Treat access to the hub as access to the orchestrator.

This is a deliberate choice for the pilot (the owner wants the same agent from the browser). It is why the pilot is the only enabled agent, why the hub adds no permission-bypass flag, and why approvals stay where they are (see below).

## What the hub guarantees

- **A fixed command line.** The gateway builds the whole `claude` command from a profile table in `gateway/gateway.js`. The browser, the hub app and the request choose nothing but the message text and which conversation it belongs to. No flag, working directory, tool list, model, environment variable or file path comes from a request.
- **No permission bypass.** No `--dangerously-skip-permissions`, no `bypassPermissions` mode, no `--allowedTools`, `--add-dir` or `--mcp-config`. The run uses permission mode `default` with `--permission-prompts none`: nobody is at the other end to approve a prompt, so anything that would have needed an approval is denied. Pre-approved actions (the workspace's own allow rules) run as they would anywhere. **Approvals for trades, sends and deploys stay with the agents' own rules**; the hub does not grant or widen them.
- **One run at a time on the host.** A second run is refused (`busy`); the gateway never queues.
- **Bounded runs.** Per-run timeout (default 10 minutes), a maximum output size (default 8 MiB), a maximum number of turns (40) and a message cap (8,000 characters in the app, 16,000 at the gateway). A run also ends, with its whole process group, when the hub disconnects from the gateway or the kill switch is set. After every run (however it ended) the process group is swept so no background child outlives it, and a process that escaped the group but holds the output pipe cannot keep the slot: the run is finished about two seconds (`EXIT_GRACE_MS`) after the main process exits.
- **Only the pilot.** Other agents are listed in the profile table as disabled and answer `not_enabled`. **Apollo is not in the table at all and is never proxied**: it keeps its own chat app, its own sign-in and its own health-data isolation, and the hub holds no Apollo chat data.
- **Only a small, safe event set reaches the browser:** text, a "thinking" signal, a generic tool label such as "reading", an error code and "done". Tool inputs, tool results, thinking text, session ids and file paths are dropped on the server.
- **Audit without content.** The gateway keeps a JSON-lines audit log (see below) with metadata only.

### The profile (machine-checked)

This is the exact flag list the gateway passes for the pilot, in order. A test compares it to the code, so the two cannot drift apart. The last argument is `--session-id <uuid>` for a conversation's first run and `--resume <uuid>` afterwards; the uuid is the hub conversation id.

<!-- profile:arshwyn:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode default
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--session-id|--resume <conversation uuid>
<!-- profile:arshwyn:end -->

The prompt is written to the process's standard input. The working directory is the orchestrator workspace. The environment is `PATH`, `HOME`, `LANG`, `HUB_CHAT_RUN=1` and `HUB_RUN_ID` only; the gateway's own environment (tokens, keys) is not passed on. A host hook can use `HUB_CHAT_RUN` to treat web runs more strictly than terminal runs.

Sources for the flags: the public Claude Code documentation, CLI reference (`claude -p`, `--output-format`, `--verbose`, `--include-partial-messages`, `--permission-mode`, `--permission-prompts`, `--setting-sources`, `--max-turns`, `--session-id`, `--resume`) and "Run Claude Code programmatically" (stream-json output, resuming a session by id, stopping a run with SIGINT or SIGTERM).

## Threat model

| Threat                                                                    | Mitigation                                                                                                                                                                      | Residual risk                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Someone reaches the hub without being the owner                           | Cloudflare Access in front; the app verifies the Access JWT itself (signature, issuer, audience, expiry, one email) and fails closed                                            | Anyone who controls the owner's Access identity controls the orchestrator                                 |
| A malicious page makes the owner's browser send a request                 | CSRF checks: a custom header plus same-origin provenance on every state-changing request; no CORS headers; JSON only                                                            | A script running inside the hub origin could still act (see prompt injection)                             |
| The browser tries to pick flags, tools, directory or agent                | Fixed profile table; strict validation; extra fields rejected                                                                                                                   | None known                                                                                                |
| Another agent is reached through the hub                                  | Only the pilot is enabled; Apollo is absent from the table                                                                                                                      | Later slices add agents one by one with their own profile                                                 |
| Prompt injection through content the agent reads (web pages, mail, files) | Same as in a terminal: the workspace's permission rules and hooks decide what runs; nothing here is more permissive                                                             | **This is the main residual risk.** The agent can be talked into actions its rules allow                  |
| A runaway or stuck run                                                    | Timeout, output cap, max turns, one run at a time, Stop button, kill switch                                                                                                     | A run can still use its allowed tools until it is stopped                                                 |
| Abuse by a compromised session                                            | Per-minute message limit, one run at a time, audit log, kill switch                                                                                                             | Limits slow abuse; they do not remove the access                                                          |
| The gateway socket is reached by another local user                       | Socket mode 0600 and a 0700 directory, owned by the service user; the container runs as that user and mounts the directory read-only                                            | Any process running as the service user can use the socket                                                |
| Secrets in logs or in the browser                                         | No prompts, replies or tool inputs are logged; the audit log has metadata only; the gateway's environment is not passed to the run; the app sends no environment to the browser | The agent itself may print a secret into a reply it generates; replies are stored in the history database |

## Mitigations you operate

- **Kill switch.** Create the file `DISABLED` in the gateway data directory (or set `GATEWAY_DISABLED=1` and restart) to refuse every new web run immediately; the gateway checks it on each request, so no restart is needed for the file. The app has its own switch, `CHAT_DISABLED=1`. The page shows a notice when either is on. **The gateway also watches the flag while a run is in progress** (every second, `KILL_POLL_MS`): a run in progress is ended with SIGINT, then SIGTERM, then SIGKILL on its whole process group, and the page shows "switched off during this reply". The app-side `CHAT_DISABLED` only refuses new sends; to end a running reply use the gateway flag or Stop.
- **Audit log.** `audit.log` in the gateway data directory (mode 0600), one JSON object per finished or rejected run: time, agent, conversation id, run id, whether it resumed, duration, exit code and signal, timed-out, cancelled, switched-off and too-large flags, output bytes, prompt length in characters, and input and output token counts. **No prompt text, no reply text, no tool input.** The same line goes to the service journal.
- **Access policy.** Keep the Access application restricted to the one owner email, with a short session, and review its logs.
- **Workspace rules.** The strongest control is the orchestrator's own permission rules and hooks. If a tool should not be available from the web, deny it there (a hook can check `HUB_CHAT_RUN`).
- **Backups and retention.** The history database holds the owner's conversations in plain text. Back it up and protect it like the other private data on the host; deleting a conversation in the hub removes it from the database but not the Claude Code session file on the host.
- **Closing the page does not stop a reply.** A run continues after the browser tab closes and its reply is saved to the history, so a reply is not lost; Stop, the timeout or the kill switch end it. The page says so in its empty state. (If the hub app itself goes away, the run ends.)
- **What is stored.** Your messages and each reply's final text. Narration the agent writes before a tool call is shown live as a muted note but is not stored, and tool activity is never stored.
- **Sessions and retries.** A conversation id is the Claude session id. The hub marks a session as started only after a run succeeds. The one retry rule: a run that fails **before it did anything** (no tool event and no text seen) is retried once in the other session mode (`--resume` instead of `--session-id`, or the reverse), so a missing or half-created session heals itself. **A run that emitted any tool event is never retried**, whatever the error, because repeating the prompt could repeat commands, writes or deploys; the error is shown and the history is kept. (Server-side and connector tool blocks, any block type ending in `tool_use`, count as tool events.) A Stop that lands while the retry is pending cancels the retry. A retry uses a fresh Claude session if the old one is gone; the hub's own history stays. If saving a finished reply to the history fails, the write is retried once and, if it still fails, the reply is still shown, with a note that it was not saved, and the page then leaves the log as it is instead of reloading it from the history; the stored row is marked as an error (it never stays "streaming"), so after a reload it shows an error, not the reply.

## What this does not cover

- It does not make the orchestrator safer than it is in a terminal.
- It does not isolate the pilot from the infrastructure it already has access to.
- It does not protect against the owner's own mistakes in what they ask the agent to do.
