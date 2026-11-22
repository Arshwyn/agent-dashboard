# Isolation and blast radius

This page says plainly what web chat can do, what it cannot, and what protects it. Read it before enabling chat on a host.

**Web chat is equivalent to remote control of the infrastructure for anyone who holds a valid owner session or who compromises the hub container (which can reach the gateway socket). The classifier and the guard hook narrow this; they are not a sandbox.**

## The plain statement

**The pilot agent (Arshwyn, the orchestrator) runs through the hub with the orchestrator's own tool access, and seven other agents run with the access their agent files give them (see "Per-agent profiles").** A pilot web chat run is the orchestrator's main session: the same workspace, the same instructions, the same settings, the same permission rules and hooks, and every tool and connector that session has. Whatever those rules let it do from a terminal, they let it do from the web.

So **a compromised web session equals control of whatever the orchestrator can reach**, including the infrastructure it can administer. The hub adds no extra sandbox around the agent. What the hub adds is a narrow, authenticated, rate-limited door and the mitigations below. Treat access to the hub as access to the orchestrator.

This is a deliberate choice (the owner wants the same agents from the browser). It is why the hub adds no permission-bypass flag, and why approvals stay where they are (see below).

### Same permission mode as the interactive session

A web run uses **permission mode `auto`**, the same classifier-based mode the interactive session of the orchestrator uses, so the web run has the same reach as the terminal, no less and no more. An earlier version ran in mode `default` with prompts off; that was stricter than the terminal (every command not on an allow rule was denied, including the read-only commands a subagent needs), and the owner decided web chat should match the interactive session. **The blast radius is therefore wider than it was in that earlier version, and these are the differences that matter** (public Claude Code documentation, permission-modes and permissions pages):

- **Reads outside the workspace run without a prompt.** In auto mode file reads are approved, including reads outside the working directories (the permission-modes page says the first-read prompt does not appear in `-p` runs, which is what the gateway starts, so in a web run the read simply runs), unless the setting `permissions.blockReadsOutsideWorkingDirectories` is on. The earlier mode with prompts off denied them. So the only things between a web run and the host's other files are the guard hook (below), explicit deny rules, and, for shell commands, the classifier. **Plainly: a web run can read host files the guard hook and the deny rules do not cover.** Two options reduce this, and the owner should choose them for the host: turn on `permissions.blockReadsOutsideWorkingDirectories` in the settings the web run loads, and add explicit `permissions.deny` rules for sensitive paths (credential directories, other users' data, key files). Deny rules block in every mode by default (a mod can override some; see "Rules and hooks" below).
- **Edits in the workspace run without a prompt.** File edits inside the working directory are auto-approved (the earlier mode denied them). A web run can edit files in the orchestrator workspace, **including the project-level `.claude/` settings, agents and hook files if they live there**. The guard hook's script and the user-level settings are outside the workspace, but the project-level `.claude/` is inside it, so keep the settings that matter (deny rules, hook registration) at user level; see "The self-weakening chain" below for what protects the project-level files and the option that is not adopted. Writes to protected paths still go through the classifier.
- **A classifier reviews each action instead of a person.** The classifier blocks by default things such as downloading and running code, sending sensitive data to external endpoints, production deploys, force pushes and hard resets. The documentation states that auto mode reduces prompts but does not guarantee safety. Treat it as a smaller set of risks, not as a sandbox.
- **Nobody can approve what falls through.** `--permission-prompts none` stays on: anything that would still have prompted is denied, and Claude is told not to retry it. In a non-interactive run, when the classifier's repeated-block threshold is reached the action does not run and Claude keeps working; the run does not stop.
- **Subagents** (for example Atlas through the Agent tool) run in the parent's mode, so they are classified the same way. A `permissionMode` in a subagent's own file is ignored when the parent is in auto mode. The `tools` allow-list in the agent file is still respected. The classifier also reviews the delegated task before it starts and the subagent's report when it ends.
- **Rules and hooks still come first.** Deny rules block in every mode, **by default** (see the caveat below). A `PreToolUse` hook that exits with code 2 stops the call before permission rules are evaluated, and **by default** a call a hook blocked stays blocked. The caveat from the permissions page: an installed mod can approve a call a hook blocked, and some calls a deny rule refuses, when the setup has no managed settings, no `managed-mcp.json` file and no Team or Enterprise login as the session's credential; do not install such mods on the host that runs the gateway. Broad allow rules that grant arbitrary code execution (a bare `Bash(*)`, wildcarded interpreters, an `Agent` allow rule) are dropped on entering auto mode, exactly as in the interactive session; narrow rules stay.
- **The guard hook for web runs still applies, and it is heuristic.** The host keeps a `PreToolUse` guard in the orchestrator's user-level settings (outside this repository and outside the workspace). It is registered at user level on every tool, acts only when `HUB_CHAT_RUN=1`, and fails closed (a crash, timeout or malformed input denies the call). It has two groups:
  - **Group 1 (secrets):** denies reads, edits and shell access to the Claude login file, the GitHub CLI configuration and the gateway's environment files.
  - **Group 2 (write protection, approved by the owner):** protects the Claude settings files and backups, the hooks directory (including the guard itself), the Claude user configuration file, `.mcp.json` files, the systemd user unit directory, and the compose and `.env` files of the hub and apollo-chat deployments. Reads of those places stay allowed.
    - **File tools** (Edit, Write, MultiEdit, NotebookEdit) are denied on the protected names, also after symlink resolution and with relative paths resolved against the call's working directory.
    - **Shell commands** are matched on protected **names**, with no slash required: `.claude` as a path component or word in every home form (`~`, `$HOME`, `${HOME}`, absolute, relative), glob forms, `settings.json`, `settings.local.json`, the Claude user configuration file, `.mcp.json`, the systemd user unit directory name and deploy trees. Directory changes (`cd`, `pushd`, `chdir`, `-C`, `--directory`, `--work-tree` and similar) are resolved relative to the call's working directory, following symlinks, so a command that runs from a protected place counts as naming it.
    - A command is **denied when it names or runs from a protected place and also has** a redirection, a heredoc, a listed write verb or writer (for example `tee`, `cp`, `mv`, `rm`, `ln`, `chmod`, `install`, `dd`, `rsync`, `sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`, `curl -o`, `wget -O`, `tar -x`, `unzip`, `find -delete` or `-exec`, and git commands that change the tree such as `checkout`, `restore`, `apply` and `reset`) or an interpreter file write (`python`, `node`, `ruby` and the like).
    - **The rules are deliberately coarse.** A command that names a protected place plus any redirection or verb is denied even if the write goes elsewhere (for example copying the settings to a scratch file, or a search for the word `install` in them). A web run must use the Write tool for notes under the Claude user directory.
  - **Remaining gaps, stated plainly.** The guard cannot see:
    - quoting tricks, paths built piecewise in shell variables, and base64 or otherwise decoded commands;
    - a script written elsewhere and then run, a writer that is not on the list, and indirect forms such as `find -exec sh -c`, `xargs sh -c` and similar wrappers that do the write without naming a protected place;
    - `cd` targets built from `$PWD`, `$(pwd)` or `~+` (for example `cd $(pwd)/link`), which are not expanded, and `$XDG_CONFIG_HOME` forms;
    - chained relative hops from a subdirectory (`cd .. && cd link`), because each hop is resolved against the call's original working directory, not cumulatively;
    - a symlink to the project `.claude` directory that already exists in the workspace or is planted by other means, which defeats every name match (creating one by naming `.claude` is denied, and the Write tool resolves links only for absolute paths);
    - Write to the project's `.claude/commands`, `CLAUDE.md` files, agents, skills and memory, which are not protected although they shape later runs;
    - MCP tools, and the Agent tool (not inspected at all).

    It is **heuristic, not a sandbox, and not a reliable barrier** against the chain below; the real boundary remains the permission mode and the classifier. Keep it working, but do not rely on it alone. Its detailed rules are kept in the host's own runbook, not in this repository.
- **The self-weakening chain.** Because auto mode lets a web run edit files in the workspace, an obfuscated write to the workspace's project-level `.claude/settings*.json` could set `disableAllHooks` and switch off every hook-based guard for later runs. The guard's group 2 catches the plain forms of such a write, and the other mitigations are the fail-closed failure handler, the audit log (a run that did this is visible afterwards) and the kill switch; **none of them is a reliable barrier against a deliberately obfuscated write.** **Open option, not adopted, and the one that matters most:** a real permission deny rule on the project `.claude/**` path. It is enforced by the harness, not a heuristic, but it would also stop interactive sessions from editing those files, so it is deliberately left to the owner to decide.
- **Not a bypass.** `bypassPermissions` and the `--dangerously-skip-permissions` flags are never used. The gateway refuses to start a run whose command line contains a flag that is not on its fixed list (so also `--settings`, `--plugin-dir`, `--tools`, `--add-dir` and the like) or a mode other than `default`, `auto` or `dontAsk` (`assertSafeArgv`, covered by tests).
- **Requirements.** Auto mode needs a model the documentation lists as supported and a Claude Code version that has `--permission-prompts` (2.1.259 or later; the host runs a later one). The mode is passed explicitly with `--permission-mode auto`, which overrides `defaultMode` from any settings file, so the run does not depend on how the terminal is configured.

## What the hub guarantees

- **A fixed command line.** The gateway builds the whole `claude` command from a profile table in `gateway/gateway.js`. The browser, the hub app and the request choose nothing but the message text and which conversation it belongs to. No flag, working directory, tool list, model, environment variable or file path comes from a request.
- **No permission bypass.** No `--dangerously-skip-permissions`, no `bypassPermissions` mode, no `--allowedTools`, `--add-dir` or `--mcp-config`; the gateway refuses such a command line, and any flag that is not on its fixed list. The run uses permission mode `auto` (the interactive session's mode, see above) with `--permission-prompts none`: nobody is at the other end to approve a prompt, so anything the classifier and the rules do not settle is denied. **Approvals for trades, sends and deploys stay with the agents' own rules**; the hub does not grant or widen them.
- **One run at a time on the host.** A second run is refused (`busy`); the gateway never queues.
- **Bounded runs.** Per-run timeout (default 10 minutes), a maximum output size (default 8 MiB), a maximum number of turns (40) and a message cap (8,000 characters in the app, 16,000 at the gateway). A run also ends, with its whole process group, when the hub disconnects from the gateway or the kill switch is set. After every run (however it ended) the process group is swept so no background child outlives it, and a process that escaped the group but holds the output pipe cannot keep the slot: the run is finished about two seconds (`EXIT_GRACE_MS`) after the main process exits.
- **Eight agents, no more.** The pilot and the seven agents in the profile table; an id that is not in the table is refused. **Apollo is not in the table at all and is never proxied**: it keeps its own chat app, its own sign-in and its own health-data isolation, and the hub holds no Apollo chat data.
- **Only a small, safe event set reaches the browser:** text, a "thinking" signal, a generic tool label such as "reading", an error code and "done". Tool inputs, tool results, thinking text, session ids and file paths are dropped on the server.
- **Audit without content.** The gateway keeps a JSON-lines audit log (see below) with metadata only.

### The profile (machine-checked)

This is the exact flag list the gateway passes for the pilot, in order (the other agents are in "Per-agent profiles"). A test compares it to the code, so the two cannot drift apart. The last argument is `--session-id <uuid>` for a conversation's first run and `--resume <uuid>` afterwards; the uuid is the hub conversation id.

<!-- profile:arshwyn:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--session-id|--resume <conversation uuid>
<!-- profile:arshwyn:end -->

The prompt is written to the process's standard input. The working directory is the orchestrator workspace. The environment is `PATH`, `HOME`, `LANG`, `HUB_CHAT_RUN=1` and `HUB_RUN_ID` only; the gateway's own environment (tokens, keys) is not passed on. A host hook can use `HUB_CHAT_RUN` to treat web runs more strictly than terminal runs.

Sources for the flags, all public Claude Code documentation at code.claude.com/docs/en: **cli-reference** (`-p`, `--output-format`, `--verbose`, `--include-partial-messages`, `--permission-mode` and its values, `--permission-prompts`, `--setting-sources`, `--max-turns` (documented, print mode only), `--session-id`, `--resume`); **headless** ("Run Claude Code programmatically": stream-json output, `--permission-mode auto` with `--permission-prompts none` for unattended runs, resuming a session by id, stopping a run with SIGINT or SIGTERM); **permission-modes** (the `auto` mode, its use with `-p`, how it treats subagents); **permissions** (deny rules and a blocking `PreToolUse` hook apply before allow rules); **sub-agents** (permission inheritance, `tools` allow-lists).

## Per-agent profiles

Seven agents run through the hub besides the pilot, each as `claude --agent <id>` with the access its agent file already gives it. **Nothing is added to what an agent can do; some things are taken away on the web (see "Health data" below).** Mercury is not in the table and Apollo is never proxied.

| Agent      | Runs as                    | Tools (from its agent file)                                                                                      | Reaches                                                                                | Approvals that stay the agent's own                                           |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Arshwyn    | the workspace main session | every tool of the session                                                                                        | everything the orchestrator can reach, including the infrastructure it administers     | the workspace's rules and hooks                                               |
| Hephaestus | `--agent hephaestus`       | no `tools` line: every tool of the session                                                                       | the project repos and their remotes, the shell, every connector except the denied ones | never merges, deploys or marks its own work verified                          |
| Themis     | `--agent themis`           | Bash, Read, Grep, Glob and the test-browser tools (navigate, snapshot, screenshot, click, type, fill, and so on) | the repos it checks out, a local test browser; no file-edit tool                       | never merges, never fixes logic findings                                      |
| Janus      | `--agent janus`            | Bash, Read, Grep, Glob, WebFetch                                                                                 | the repos and the remotes (it merges after a clean review); no file-edit tool          | merges only a commit the gate cleared, with no critical findings              |
| Atlas      | `--agent atlas`            | Bash, Read, Grep, Glob, Edit, Write, WebFetch                                                                    | the servers and hypervisor hosts through the host's wrappers, the ops docs             | its own auto-remediation tiers; everything else is a question                 |
| Plutus     | `--agent plutus`           | no `tools` line: every tool of the session                                                                       | the finance connectors and the shell                                                   | never trades or moves money without the owner                                 |
| Iris       | `--agent iris`             | no `tools` line: every tool of the session                                                                       | mail, calendar and documents connectors                                                | never sends, shares or accepts without the owner's approval of the exact text |
| Dionysus   | `--agent dionysus`         | no `tools` line: every tool of the session                                                                       | web research and the shell                                                             | never books or pays without the owner                                         |

All run in permission mode `auto` with `--permission-prompts none`, the same as the pilot, and with the workspace's settings, rules and hooks (`--setting-sources user,project,local`). The web has no approval prompt: an agent that needs the owner's yes asks in the chat and the owner answers in text, as in a terminal. **Reading the table plainly: a stolen owner session now reaches Atlas (servers), Hephaestus (repos and the shell), Iris (mail, calendar, documents) and Plutus (finance connectors), not only the pilot.** That is the owner's decision (each agent keeps the access it has); the controls are the same as for the pilot.

**How the profile is enforced.**

- The gateway builds `--agent <id>` itself from a fixed table. The request names an agent id, the gateway looks it up with `Object.hasOwn`, and an id that is not in the table is refused (`apollo`, `mercury`, `__proto__`, anything else). The app has its own allowlist of the same eight ids and never forwards another one; a test keeps the app list, the gateway table and the roster's chat entries identical. A conversation belongs to one agent for its whole life: the agent comes from the stored conversation, never from the send request.
- Claude Code applies the agent file's `tools` list and model to a session started with `--agent` (public sub-agents documentation, "Run the whole session as a subagent"). The gateway therefore passes no `--tools` or `--allowedTools`. `assertSafeArgv` throws unless `--agent` appears exactly once and equals the profile's own id (never `apollo`) for these seven, appears not at all for the pilot, and carries no flag outside the fixed list.
- **Drift check.** At the start of every run the gateway reads the first lines of the agent file in the workspace and compares only the keys that change what the agent can do: the `tools` line must equal the table (or be absent for the four agents that inherit every tool), and `disallowedTools`, `permissionMode`, `mcpServers` and `hooks` must not appear. A missing or unreadable file, a widened list or one of those keys answers `profile_mismatch`: nothing is started and the audit log records the rejection. The text of the agent file never matters. Changing an agent's tools on purpose therefore means changing the table, this page and the test in one change.
- The model comes from the agent file unless the operator sets `GATEWAY_MODEL`, which then overrides it for every run.

**Health data.** The aim is that Apollo never runs here and no other agent gets health data. Two layers work towards it, and only the first is enforced by the gateway:

1. **The deny list (gateway).** The host's own isolation hook only fences runs of the Apollo agent, so an all-tools agent could otherwise call the health connectors or start Apollo through the Agent tool. Every web profile, the pilot included, therefore passes `--disallowedTools` with `Agent(apollo)` (built in, cannot be removed) and the connector patterns from `HUB_DENY_TOOLS` in the gateway's environment file (real connector names stay out of this repository). **This blocks the health connectors and starting Apollo as an agent, and nothing more.** While the list is empty no profile starts (`not_configured`), and an entry of any other shape stops the gateway at start. This narrows the pilot compared with a terminal session, on the owner's decision.
2. **The host guard hook (not in this repository).** Every agent except Themis and Janus keeps the shell and file tools, and Themis and Janus keep Bash and Read, so a web run could still read the Apollo memory folders directly or start a nested `claude` process that does not carry the deny flags. **The deny list does not close that.** It is closed only by the host's web-run guard hook, which must carry a group that, when `HUB_CHAT_RUN=1`, refuses access to the Apollo memory folders and refuses any `claude` invocation from the shell. **That group is a heuristic, not a sandbox**: like the other guard groups it matches names and common write forms and cannot see every encoded, indirect or piecewise command. Treat health separation on the web as reduced and best effort, not as a guarantee.

### Host prerequisites for health separation

Before enabling any agent in web chat the host must have, and the owner must confirm in the smoke test (`docs/DEPLOY.md`):

- `HUB_DENY_TOOLS` set in the gateway environment file, one entry per health connector.
- The web-run guard hook group described above, registered at user level, failing closed, and active only when `HUB_CHAT_RUN=1`: reading or searching the Apollo memory folders from a web run is refused, and so is launching `claude` from the shell.
- Agent files unchanged from the documented tool lists (the drift check refuses a run otherwise).

Without the hook group the deny list still holds, but the residual reach above is open.

### Profile of the other agents (machine-checked)

Each block is the exact flag list the gateway passes for that agent, in order, compared with the code by a test. The `--disallowedTools` value is the built-in denial plus `HUB_DENY_TOOLS`.

#### hephaestus

<!-- profile:hephaestus:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent hephaestus
--session-id|--resume <conversation uuid>
<!-- profile:hephaestus:end -->

#### themis

<!-- profile:themis:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent themis
--session-id|--resume <conversation uuid>
<!-- profile:themis:end -->

#### janus

<!-- profile:janus:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent janus
--session-id|--resume <conversation uuid>
<!-- profile:janus:end -->

#### atlas

<!-- profile:atlas:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent atlas
--session-id|--resume <conversation uuid>
<!-- profile:atlas:end -->

#### plutus

<!-- profile:plutus:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent plutus
--session-id|--resume <conversation uuid>
<!-- profile:plutus:end -->

#### iris

<!-- profile:iris:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent iris
--session-id|--resume <conversation uuid>
<!-- profile:iris:end -->

#### dionysus

<!-- profile:dionysus:begin -->

-p
--output-format stream-json
--verbose
--include-partial-messages
--permission-mode auto
--permission-prompts none
--setting-sources user,project,local
--max-turns 40
--disallowedTools <deny list>
--agent dionysus
--session-id|--resume <conversation uuid>
<!-- profile:dionysus:end -->

## Threat model

| Threat                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                                               | Residual risk                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Someone reaches the hub without being the owner                           | Cloudflare Access in front; the app verifies the Access JWT itself (signature, issuer, audience, expiry, one email) and fails closed                                                                                                                                                                                                                                                     | Anyone who controls the owner's Access identity controls the orchestrator                                  |
| A malicious page makes the owner's browser send a request                 | CSRF checks: a custom header plus same-origin provenance on every state-changing request; no CORS headers; JSON only                                                                                                                                                                                                                                                                     | A script running inside the hub origin could still act (see prompt injection)                              |
| The browser tries to pick flags, tools, directory or agent                | Fixed profile table; strict validation; extra fields rejected                                                                                                                                                                                                                                                                                                                            | None known                                                                                                 |
| Another agent is reached through the hub                                  | Only the eight table entries run, each with its own fixed profile, drift check and denied tools; Apollo is absent from the table and denied as a sub-agent                                                                                                                                                                                                                               | Each agent's own reach (see the table above); an agent file edited without the table fails the drift check |
| Prompt injection through content the agent reads (web pages, mail, files) | Same as in a terminal: the workspace's permission rules and hooks decide what runs; nothing here is more permissive                                                                                                                                                                                                                                                                      | **This is the main residual risk.** The agent can be talked into actions its rules allow                   |
| A runaway or stuck run                                                    | Timeout, output cap, max turns, one run at a time, Stop button, kill switch                                                                                                                                                                                                                                                                                                              | A run can still use its allowed tools until it is stopped                                                  |
| Abuse by a compromised session                                            | Per-minute message limit, one run at a time, audit log, kill switch                                                                                                                                                                                                                                                                                                                      | Limits slow abuse; they do not remove the access                                                           |
| Hub app or container compromised (RCE in the app or a dependency)         | Same consequence as a stolen owner session: arbitrary prompts to any of the eight agents through the socket. Mitigations: read-only root filesystem and socket mount, all capabilities dropped, no secrets in the container environment, the kill switch and the audit log live outside the container (in the gateway's own directory, which is not mounted), the guard hook (heuristic) | The attacker can do what the owner can do through chat until the kill switch is set                        |
| The gateway socket is reached by another local user                       | Socket mode 0600 and a 0700 directory, owned by the service user; the container runs as that user and mounts the socket directory read-only                                                                                                                                                                                                                                              | Any process running as the service user can use the socket                                                 |
| Secrets in logs or in the browser                                         | No prompts, replies or tool inputs are logged; the audit log has metadata only; the gateway's environment is not passed to the run; the app sends no environment to the browser                                                                                                                                                                                                          | The agent itself may print a secret into a reply it generates; replies are stored in the history database  |

## Apollo in the hub view

Apollo is still not in the profile table and never runs through the hub. With `APOLLO_EMBED=1` the Apollo pane shows the separate Apollo chat app in an iframe. Options weighed: a same-origin reverse proxy (health text would pass through the hub process and origin, and the two Access audiences would have to be mixed), the hub calling the Apollo app's API (CORS or a service token, health text in hub code, the hub would start Apollo runs), and a cross-origin frame. Only the frame keeps the data out of the hub, so it is the design.

What it does and does not do:

- **The hub cannot read the frame.** Different origin, so the same-origin policy blocks its DOM, requests and storage. The hub fetches, proxies, stores and logs nothing from the Apollo origin; the hub history store, request log and gateway audit log stay as before. The frame address is exactly `APOLLO_CHAT_URL`: no path, query or parameter is added, and no identity or token is passed to it. Who is signed in inside the frame is decided by the browser's own Access session for the Apollo app; the hub's Access audience is not valid there and is not widened, and no service token exists.
- **CSP.** With the embed off the hub's policy is unchanged. With it on, the only difference is `frame-src <the Apollo origin>`; `frame-ancestors 'none'`, `X-Frame-Options: DENY` and the rest are unchanged, and the hub cannot be framed. The Apollo app, for its part, names the hub origin as its one allowed frame ancestor (its own setting).
- **The frame element.** One iframe, created while Apollo is selected and removed when another agent is chosen. `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"` (no top navigation, no popups; modals because the Apollo app uses confirm and prompt dialogs), `referrerpolicy="no-referrer"`, `allow="clipboard-write"` only.
- **State messages.** The Apollo app posts `{type:'apollo-ready'}` and `{type:'apollo-state', state}` (idle, thinking, speaking). The hub accepts a message only when `origin` equals the configured origin, `source` is the frame's window, the shape is exactly one of those two and the state is one of the three; everything else is dropped. Values stay in memory, drive the orb and are never sent to the server, stored or logged. They reveal when Apollo is replying, never what is said.
- **Signed out.** The Access login page refuses framing, so a missing or expired Apollo session leaves the frame blank. The hub never tries to get around that: with no ready message within 8 seconds it shows a hint and a link that opens Apollo in its own tab to sign in. The two Access applications keep separate sessions, so the frame works while the Apollo session lasts.
- **Users.** The hub admits only the owner, so the other user never sees the hub shell and keeps using the Apollo app directly. Nothing in the hub chooses a user for the frame.
- **Residual.** A compromised hub page could overlay or clickjack the frame, or observe the activity timing, but cannot read the conversation. The text is visible on screen next to the other agents. One more live page on a small host while Apollo is open.

Tests: `test/server.test.js` (exact CSP in both modes, no route or request to the Apollo origin, no other source file uses the setting), `test/apollostate.test.js` (message filter, one frame with the fixed attributes, no storage or network in the Apollo code), `test/config.test.js`.

## Browser storage and install support

The page keeps nothing in the browser: no `localStorage`, `sessionStorage`, IndexedDB, Cache API, service worker or web app manifest, no notifications and no sound. The new-reply marker and every other page state live in memory and are lost on reload. Install support (a manifest or a service worker) was considered and declined by the owner: a service worker sits between the browser and authenticated pages, could cache private chat responses and breaks when Access expires the session. `test/tracker.test.js` checks the shipped scripts and `index.html` for these APIs.

## Mitigations you operate

- **Kill switch.** Create the file `DISABLED` in the gateway data directory (or set `GATEWAY_DISABLED=1` and restart) to refuse every new web run immediately; the gateway checks it on each request, so no restart is needed for the file. The app has its own switch, `CHAT_DISABLED=1`. The page shows a notice when either is on. **The gateway also watches the flag while a run is in progress** (every second, `KILL_POLL_MS`): a run in progress is ended with SIGINT, then SIGTERM, then SIGKILL on its whole process group, and the page shows "switched off during this reply". The app-side `CHAT_DISABLED` only refuses new sends; to end a running reply use the gateway flag or Stop.
- **Gateway start is careful.** It replaces only a leftover socket that nothing answers on: a regular file, directory or link at the socket path, or a socket another gateway may still be using (anything but a clear "connection refused" or "no such file" counts as live, so a gateway that is merely busy is never taken for dead), stops the start with an error. The check and the unlink are two steps; a gateway started in that gap could be missed. That is accepted because a single systemd unit starts the gateway. A data or socket directory that is a symlink, is not a directory or is not owned by the service user is refused.
- **Directory layout.** Three private directories: the **socket directory** (only `gateway.sock`; this is the one mounted read-only into the container), the **gateway directory** (`GATEWAY_DATA_DIR`: the environment file, the audit log and the kill-switch file; never mounted, so the container cannot read the audit log or touch the kill switch) and the hub's data directory. Keeping the environment file out of the socket directory matters because that directory is visible inside the container.
- **Audit log.** `audit.log` in the gateway data directory (mode 0600), one JSON object per finished or rejected run: time, agent, conversation id, run id, whether it resumed, duration, exit code and signal, timed-out, cancelled, switched-off and too-large flags, output bytes, prompt length in characters, and input and output token counts. **No prompt text, no reply text, no tool input.** The same line goes to the service journal.
- **Access policy.** Keep the Access application restricted to the one owner email, with a short session, and review its logs.
- **Workspace rules.** The strongest control is the orchestrator's own permission rules and hooks. If a tool should not be available from the web, deny it there (a hook can check `HUB_CHAT_RUN`).
- **Backups and retention.** The history database holds the owner's conversations in plain text. Back it up and protect it like the other private data on the host; deleting a conversation in the hub removes it from the database but not the Claude Code session file on the host.
- **Closing the page does not stop a reply.** A run continues after the browser tab closes and its reply is saved to the history, so a reply is not lost; Stop, the timeout or the kill switch end it. The page says so in its empty state. (If the hub app itself goes away, the run ends.)
- **Stop is honest.** Stop answers 202 only when the run was ended or will be: a Stop that reaches the gateway before the run has registered is remembered for 15 seconds and the run is not started; a Stop for a run that already finished is refused (409).
- **A refused send leaves nothing behind.** A send the app or the gateway refuses (busy, rate limit, switched off, not reachable, too long) stores no message, keeps the conversation title, and the page shows a plain notice and keeps your text in the box.
- **What is stored.** Your messages and each reply's final text. Narration the agent writes before a tool call is shown live as a muted note but is not stored, and tool activity is never stored.
- **Sessions and retries.** A conversation id is the Claude session id. The hub marks a session as started only after a run succeeds. The one retry rule: a run that fails **before it did anything** (no tool event and no text seen) is retried once in the other session mode (`--resume` instead of `--session-id`, or the reverse), so a missing or half-created session heals itself. **A run that emitted any tool event is never retried**, whatever the error, because repeating the prompt could repeat commands, writes or deploys; the error is shown and the history is kept. (Server-side and connector tool blocks, any block type ending in `tool_use`, count as tool events.) A Stop that lands while the retry is pending cancels the retry. A retry uses a fresh Claude session if the old one is gone; the hub's own history stays. If saving a finished reply to the history fails, the write is retried once and, if it still fails, the reply is still shown, with a note that it was not saved, and the page then leaves the log as it is instead of reloading it from the history; the stored row is marked as an error (it never stays "streaming"), so after a reload it shows an error, not the reply.

- **Optional systemd hardening (unverified).** The unit in `docs/host/` sets a private umask and two resource limits (`MemoryMax`, `TasksMax`), nothing else. Further options such as `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict` with `ReadWritePaths=`, `ProtectHome=read-only` or a `RestrictAddressFamilies=` list have not been tested with Claude Code and the orchestrator's tools; some would take away what the interactive session has (`NoNewPrivileges` blocks `sudo` and other setuid helpers, `ProtectSystem` blocks writes the agent may need). Add them one at a time, run the smoke test after each, and expect to back some out.

## What this does not cover

- It does not make the orchestrator safer than it is in a terminal.
- It does not isolate the pilot, Atlas or the other agents from what they already have access to.
- It does not protect against the owner's own mistakes in what they ask the agent to do.
