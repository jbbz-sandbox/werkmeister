# Proposal: reorganizing Werkmeister's CLI, runtime placement, resource budget, and harness coupling

Status: proposal for discussion. Written 2026-10-28 against commit `07af58b`.
Nothing in this document is implemented.

## How to read this document

Every section is built the same way. First comes what exists today, with the file
it was read from. Then comes the problem with it, stated so it can be disagreed
with. Then comes the proposed change, and what would have to move to make it
happen. Where a claim is a guess rather than something read in a file or checked
on the web, the text says so.

A few terms are used throughout, each defined once here:

- **Harness**: the program that runs the AI model and gives it tools. Claude Code
  is one harness. Codex CLI, Gemini CLI and Cursor are others.
- **MCP** (Model Context Protocol): the standard way a harness calls tools that
  another program provides. Werkmeister already ships an MCP server in
  `apps/werkmeister-mcp`.
- **Hook**: a command the harness runs at a fixed moment, for example before every
  file edit or when a session ends. Werkmeister installs several into each
  workspace.
- **Skill**: a folder holding a `SKILL.md` file with instructions the model loads
  when a task matches the file's description.
- **Workspace**: one folder per piece of work, holding git worktrees of the repos it
  touches, a generated `compose.yml`, and the files the agent reads.
- **Worktree**: a second checkout of a git repository that shares its history with
  the main checkout. Werkmeister creates one per repo per workspace.
- **Feature**: the running containers for a workspace, plus the routing that sends
  browser traffic to them.
- **Slot**: a numbered port range a running feature owns. There are 12 by default.
- **Daemon**: a program that keeps running in the background and answers requests
  from other programs.
- **Lease**: a time-limited permission to use a share of some capacity, which has to
  be renewed or it expires.

## 0. What Werkmeister is made of today

This section exists so the four proposals can refer to the pieces by name.
Source: `README.md`, `docs/werkmeister-architecture.md`, `docs/topology.md`.

| Piece | Where | What it does |
|---|---|---|
| The CLI | `apps/cli` | The `werkmeister` and `w9r` commands. A shell wrapper finds `node` and runs `dist/main.js`. |
| The core library | `packages/werkmeister-core` | Everything the CLI, the MCP server, the dashboard and the VS Code extension share: config, workspace creation, container lifecycle, PR lifecycle, issue trackers. |
| The MCP server | `apps/werkmeister-mcp` | Every Werkmeister verb as an MCP tool, over stdio for a local harness and over authenticated HTTP on port 3002 for anything else. |
| The Claude Code plugin | `plugins/werkmeister` | Skills for diagnosing and operating Werkmeister, plus a workspaces pane for Claude Desktop. |
| The dashboard | `apps/werkmeister-dashboard` | A localhost web page listing workspaces. Checkout only. |
| Machine state | `~/.werkmeister` | Config, the merged service registry, secrets, locks, generated infra files. |
| Containers | Docker | Per-feature service containers, plus the shared `caddy` reverse proxy and the `k8s-forwards` container. |

The agent runs on the host, in a workspace folder. Werkmeister prepares that folder
for it: `CLAUDE.md`, hooks in `.claude/settings.json`, skills in `.claude/skills`,
subagents in `.claude/agents`, and `.mcp.json`. The hooks call back into the CLI.

---

## 1. The CLI: one grammar, grouped help, and long-form documentation

### 1.1 What exists

The CLI registers 38 top-level commands in `apps/cli/src/main.ts`, plus `mcp` and
`dashboard`, which the shell wrapper intercepts before `main.ts` loads, plus two
hidden modes, `__complete` and `__reference`. Source: the `SPECS` array in
`apps/cli/src/main.ts`, and the `case` block in `apps/cli/werkmeister`.

Those commands express "do X to Y" in three different grammars at once:

1. **A bare verb.** `up`, `down`, `stop`, `restart`, `pause`, `resume`, `status`,
   `logs`, `services`, `test`, `open`, `connect`, `clean`, `stats`, `optimize`,
   `setup`, `config`, `migrate`, `code`, `detect`.
2. **A noun with an action argument.** `pr <gate|open|status|adopt|watch|new>`,
   `issue <view|update|create|start|ready>`, `notes <context|graduate>`,
   `skills <check|sync>`, `standards <check>`, `cache <prune>`,
   `registry [sync]`, `hooks <gate|pr-guard|agent-state>`.
3. **A flag that changes what the command is.** `stop --if-idle` is a session-end
   hook, `stop --idle 30` is the idle reaper, `pr watch --install` installs a
   schedule, `test --scaffold` writes files instead of testing, `status --k8s` and
   `connect --k8s` narrow to one container, `config --write` versus `config --show`
   versus `config --check`.

Workspace operations are spread across five spellings: `workspace` creates one,
`init-workspace` reconciles one, `list-workspaces` lists them, `close-out` ends
one, `remove-workspace` is deprecated, and `code` opens one in an editor.

Commands meant for people sit beside commands meant for machines. `hooks gate` runs
on every file edit; `start-args` prints JSON for a pane button; `__reference` feeds
the docs generator. All of them appear in the same `--help` list, in registration
order, with no grouping. Source: `program.outputHelp()` in `main.ts`, and the
generated list in `docs/users-guide.md` under "All commands".

Because a noun's actions share one argument, flags that belong to one action have to
say so in prose. The `pr` command's action description is a single 400-character
string, and the `issue` command documents `--project` as "create: the Jira project
key to file in; ready: a project from projects: in config.yaml". Source: the `pr`
and `issue` specs in `main.ts`.

Two facts limit how freely this can change. `apps/cli/CONVENTIONS.md` says the CLI
surface is frozen: flag names, help text, output and exit codes are contracts. And
`packages/werkmeister-core/src/hooks_gen.ts` writes permission rules into every
autonomous workspace that name commands by their exact spelling, such as
`Bash(werkmeister up)` and `Bash(werkmeister pr:*)`. Any rename has to carry the old
spelling for a while and update those rules in the same change.

### 1.2 The problem, stated plainly

A person learning the tool cannot predict where a command lives. "Stop a workspace's
containers" is `stop`, "stop a workspace" is `close-out`, and "stop a service" is
`remove`. The help output lists about forty entries with no sections, so the
everyday five (`up`, `down`, `status`, `logs`, `test`) are not distinguishable from
the hook entry points. Per-command help explains what a flag does but not when to
use the command, what it writes, or what its exit codes mean. That information lives
in `docs/users-guide.md`, which a person has to go and find.

### 1.3 Proposal: noun groups, two levels deep, with a stable set of top-level verbs

Organize every command as `werkmeister <noun> <verb>`, never deeper than that. Keep
the everyday verbs available at the top level as aliases, because an agent types
`werkmeister up` hundreds of times a day and the permission rules already name it.

| Group | Verbs | What it replaces |
|---|---|---|
| `feature` | `up`, `down`, `stop`, `restart`, `pause`, `resume`, `status`, `logs`, `services`, `drop <service>`, `test`, `open` | the bare verbs today; `drop` replaces `remove` |
| `workspace` (alias `ws`) | `new`, `init`, `list`, `close`, `abandon <reason>`, `code`, `prompt` | `workspace`, `init-workspace`, `list-workspaces`, `close-out`, `close-out --abandon`, `code`, `starting-prompt` and `start-args` |
| `pr` | `gate`, `open`, `status`, `adopt`, `watch`, `new` | unchanged, but each verb becomes a real subcommand so its flags are its own |
| `issue` | `view`, `update`, `create`, `start`, `ready` | unchanged, same treatment |
| `infra` | `up`, `down`, `restart`, `status`, `proxy reload`, `intercept` | `connect`, `up infra`, `down infra`, `status --k8s`, `proxy-reload`, `intercept` |
| `context` | `skills check\|sync`, `standards check`, `notes context\|graduate` | `skills`, `standards`, `notes` |
| `machine` | `setup`, `config`, `registry sync`, `detect`, `migrate`, `cache prune`, `clean`, `stats`, `optimize`, `budget` | the machine-wide commands; `budget` is new, see section 3 |
| `internal` (hidden from help) | `hook <event>`, `session-end`, `reap`, `complete`, `reference`, `mcp`, `dashboard` | `hooks gate\|pr-guard\|agent-state`, `stop --if-idle`, `stop --idle`, `__complete`, `__reference`, `mcp`, `dashboard` |

Top-level aliases that stay: `up`, `down`, `stop`, `restart`, `status`, `logs`,
`test`, `open`, `pause`, `resume`. Everything else moves under its noun, and the old
spelling keeps working as a hidden alias that prints one deprecation line for a
fixed number of releases.

The reason for a hidden `internal` group rather than deleting those entries: the
hooks run on every tool call and need a stable spelling, and `docs:check` reads
`__complete` and `__reference` to validate the docs. They have to exist, but a person
never types them.

### 1.4 Proposal: one source for help, the user's guide, and man pages

Today `main.ts` holds a one-line description per command, `docs/users-guide.md`
holds the long explanation, and `scripts/gen-docs.mjs` copies the one-liners into
the guide's "All commands" list. The long explanation is hand-written and drifts.

Proposed: each command module gets a sibling `help.md` with fixed sections:
Synopsis, Description, Examples, Files it reads and writes, Exit codes, See also.
Three outputs are generated from it and from commander's model:

1. **`werkmeister <noun> <verb> --help`** prints the one-line description, the flags,
   and the Examples section. `werkmeister help <noun> <verb>` prints the whole file.
2. **The users guide's reference section** is regenerated from the same files by
   `docs:gen`, so the guide cannot drift from the CLI.
3. **Man pages.** A man page is the Unix manual entry shown by `man werkmeister`. One
   page per noun (`werkmeister-feature.1`, `werkmeister-pr.1`, and so on) plus a top
   page, generated from the same `help.md` files at build time and listed under the
   `man` key in `apps/cli/package.json`, which npm installs on a global install. The
   generator runs at build time only, so the "no new runtime dependencies" rule in
   `CONVENTIONS.md` is not broken.

Grouped help output needs commander 14, which added `commandsGroup()` and
`optionsGroup()`. The CLI pins commander 13 today. Source: `apps/cli/package.json`;
the commander 14 release notes, checked on the web on 2026-10-28.

Two smaller additions: turn on commander's "did you mean" suggestion after an unknown
command, and make `werkmeister` with no arguments print the grouped help with the
everyday verbs first.

### 1.5 What has to change, in order

1. Upgrade commander to 14 and add groups to the existing flat list. No renames yet.
   This alone fixes the unreadable `--help`.
2. Add `help.md` per command and the generator for `--help`, the guide, and man
   pages. Still no renames.
3. Introduce the noun groups with the old names as hidden aliases. Update the
   autonomous allow and deny rules in `hooks_gen.ts`, the plugin skills that shell
   out to the CLI, the generated workspace skills in `apps/cli/infra/skills`, and
   the `RETIRED` list in `scripts/check-docs.mjs`. Regenerate the docs.
4. After the deprecation window, drop the aliases.

Steps 1 and 2 are safe to do at any time. Step 3 is the breaking one and should land
after sections 2 and 3 below, because they add verbs (`budget`, a waiting state) that
belong in the new tree.

---

## 2. Where Werkmeister runs: what must stay on the host, and what can move

### 2.1 What exists

Everything runs on the host today: the CLI, the MCP server, the dashboard, the
hooks, and Claude Code itself. Only the services run in containers, along with
`caddy` and `k8s-forwards`. Source: `docs/topology.md`.

The repo already documents three ways to move the agent off the host, in
`docs/users-guide.md` under "Running the agent itself in isolation":

1. A plain container holding the agent, with the host's MCP server on port 3002 as
   the only way to drive Werkmeister.
2. Docker Sandboxes, which run the agent in a small virtual machine with its own
   Docker engine, so a mounted socket shows it an empty engine rather than the
   host's containers.
3. A full virtual machine running a second complete Werkmeister install.

The repo also records why the socket matters. `docs/docker-socket-replacement.md`
shows that a container holding the Docker socket can start a privileged sibling
container with the host's root filesystem mounted, and that read-write mounts of
`~/repos` and `~/features` let container code rewrite files the host runs later.
Both are host-level code execution.

Docker Sandboxes was checked on the web on 2026-10-28: Docker's own documentation
says it runs each agent in a microVM, gives it no access to the host Docker daemon,
and supports Claude Code, Codex, Copilot, Gemini, Kiro and OpenCode.

### 2.2 What must run on the host, and why

| Must be on the host | Reason | Source |
|---|---|---|
| Whatever holds the Docker socket: `up`, `down`, `stop`, `pause`, the gate's `docker exec`, `stats` | The socket is equivalent to root on the host | `docs/docker-socket-replacement.md` |
| Caddy and `k8s-forwards` containers | They are containers, so they live wherever the Docker engine is | `docs/topology.md` |
| Telepresence in host mode | It needs a network device and the host's DNS resolver; with `--docker-daemon` it moves into a container but then needs the socket | `docs/topology.md` |
| `setup`'s `/etc/hosts` and certificate steps | Both need `sudo` on the machine the browser runs on | `docs/users-guide.md` |
| `open`, `code`, "Continue in Terminal", `claude://` links | They launch host GUI programs | `packages/werkmeister-core/src/sandbox.ts`, `plugins/werkmeister/hooks/register.tsx` |
| The `pr watch` schedule | It is a launchd or cron entry on the host | `apps/cli/src/commands/pr.ts` description |
| Reading Claude Code's session files | They live under `~/.claude` on whichever machine the harness runs | `packages/werkmeister-core/src/lifecycle.ts`, `liveSessions` |

Everything else is a file read or write inside a workspace, or a network call, and
can run anywhere the workspace folder is visible.

### 2.3 Can the agent be on a different machine from Werkmeister?

Yes, with three conditions, all of which the users guide already states for the
container case and which hold equally for a separate machine:

1. The workspace folders must be visible at the **same absolute path** as on the
   host. A worktree's `.git` is a file holding an absolute path into the main
   checkout, so a different mount point breaks every git command. Source:
   `docs/users-guide.md`, "What every shape needs".
2. The agent must reach the host's MCP server on port 3002 with the token from
   `~/.werkmeister/mcp-token`. The server already refuses browser origins and
   requires the bearer token. Source: `docs/users-guide.md`, same section.
3. The agent must have the Werkmeister verbs it needs through that server, not
   through a local `werkmeister` binary.

Condition 3 is where today's design has a real gap. Every hook Werkmeister installs
is written as `command -v werkmeister >/dev/null 2>&1 && werkmeister ... || true`.
Source: `SESSION_START_COMMAND` and its siblings in
`packages/werkmeister-core/src/hooks_gen.ts`. In a container without the binary,
every hook silently does nothing. That means the standards gate, the PR guard, the
agent-state recorder, the pause gate, and auto-stop all stop working the moment the
agent leaves the host. The users guide says the plugin's skills also stop working
there, since they shell out to the CLI.

A second gap: idle-stop and pause decide whether a session is live by reading
`~/.claude/sessions/*.json` on the host. Source: `liveSessions` in `lifecycle.ts`.
An agent in a container writes those files inside the container, so the host sees no
session and may stop its containers under it.

### 2.4 Proposal: a host daemon with one privileged API, and a thin client everywhere else

Split Werkmeister into two named parts.

**The host side** holds every privilege listed in 2.2: the Docker socket, slots and
locks, Caddy regeneration, telepresence, the scheduler from section 3, and the
machine config. It is the existing HTTP MCP server on port 3002, promoted from an
optional bridge to the one place privileged work happens. It already exposes about
twenty verbs over authenticated HTTP. Source: `apps/werkmeister-mcp/src/tools.ts`.

**The client side** is the CLI, the hooks, and the stdio MCP server, running wherever
the agent runs. It never opens the socket. When `WERKMEISTER_HOST` is set, say to
`http://host.docker.internal:3002`, every verb that touches Docker is sent to the host
side instead of run locally. When it is unset, the CLI behaves as today, so a laptop
with everything on the host changes nothing.

What this buys, concretely:

- The hooks work in a container, because the thin client is a small npm package with
  no `dockerode` dependency and no socket. The `|| true` fallback can then be replaced
  with a real "the host is unreachable" message.
- The agent-in-container shape becomes the recommended secure default rather than a
  documented workaround, and Docker Sandboxes or a plain container both work the
  same way.
- Session liveness moves to Werkmeister's own files. The hooks already write
  `.werkmeister/agent-state.json` on every tool call. Source:
  `packages/werkmeister-core/src/agent_state.ts`. Add a session-start and session-end
  record to that file, with the harness's session id, and idle-stop and pause read it
  instead of `~/.claude/sessions`. This also removes one Claude Code dependency, which
  section 4 needs.
- Enforcement moves to the host. Today an autonomous workspace is held back by
  permission rules written into `.claude/settings.json`, and `docs/context-strategies.md`
  itself calls them "a guardrail rather than a boundary". A per-workspace token on the
  host side that only permits verbs on that workspace's own feature is a boundary,
  because the container has no other way to reach Docker.

### 2.5 What this costs on a laptop

The host side is one more long-running process. Measured numbers in
`docs/werkmeister-architecture.md` put a Claude Code session at about 0.6 GB across
its processes and a local service at about 0.5 GB, so one Node process for the host
side is small beside either. That is a guess by comparison, not a measurement of the
daemon itself.

There is one likely saving. The hooks fire on every tool call, and each one starts a
fresh `node` process. The wrapper already has three special-cased fast paths for
`hooks gate`, `hooks pr-guard` and `hooks agent-state` to keep that cold start short.
Source: `apps/cli/werkmeister`. With a host side already running, a hook can become
one small HTTP request instead of a process start. Whether that is faster should be
measured before it is relied on.

### 2.6 What has to change

1. Give the HTTP MCP server a per-workspace token scoped to one feature, alongside
   the machine-wide token it has today.
2. Add the `WERKMEISTER_HOST` client mode to the CLI: each Docker-touching verb gets
   a "send to host" branch.
3. Move session liveness into `agent-state.json`.
4. Publish the thin client as the package a container installs, and change the
   generated hooks to call it with a clear failure message.
5. Rewrite the three isolation shapes in the users guide as one recommended setup
   with Docker Sandboxes or a plain container, and one advanced setup with a full VM.

---

## 3. A resource budget: queueing features, and putting sessions on hold

### 3.1 What exists

Several separate mechanisms already limit load, none of them aware of each other:

| Mechanism | What it does | Source |
|---|---|---|
| Per-container limits | `memory_limit`, `memory_reservation` and `cpus` in each repo's `services.yaml`, rendered into `compose.yml` | `apps/cli/infra/templates/docker-compose.feature.yml.njk`, `docs/docker-resource-optimization.md` |
| Slots | 12 port ranges; `up` fails with "No available slots" when all are taken | `packages/werkmeister-core/src/slots.ts` |
| Install slots | At most 2 dependency installs at once host-wide, and builds one at a time, through lock files | `apps/cli/infra/compose/scripts/werkmeister-install-startup.sh`, `docs/users-guide.md` |
| Idle reaper | `stop --idle <minutes>` stops features nothing has used; default 30 minutes; run every 10 minutes by `pr watch` | `stopIdle` and `idleStopMinutes` in `lifecycle.ts` |
| Auto-stop | A session-end hook stops the feature when no other session is open in the workspace | `stop --if-idle` in `apps/cli/src/commands/stop.ts` |
| Pause and resume | Freezes containers with `docker pause` and holds the session by writing `paused.json`, which the agent-state hook checks on every tool call | `pause` in `lifecycle.ts`, `hooks_gen.ts` docstring |
| Stats and optimize | Measure usage and recommend new limits, by hand | `apps/cli/src/commands/stats.ts`, `optimize.ts` |

Nothing decides whether there is room *before* `up` starts containers. The documented
failure is "Cannot allocate memory on container start", with the advice to reduce
reservations or run fewer services. Source: `docs/docker-resource-optimization.md`,
Troubleshooting. The architecture doc's measured numbers say the Docker memory
allocation runs out first on a laptop, well before CPU. Source:
`docs/werkmeister-architecture.md`, Resource Estimation.

One fact matters for the design and is easy to get wrong: a paused container keeps
all of its memory. `docker pause` stops the processes from using the CPU but does not
free RAM. Only `stop` frees memory, and `stop` keeps the slot and the volumes, so a
stopped feature restarts quickly. This is how Docker's pause works in general; the
code's own comment that pause "freezes" containers is consistent with it.

### 3.2 Proposal: a budget, leases, and a waiting state

**The budget.** A new block in `~/.werkmeister/config.yaml`:

```yaml
budget:
  memory: 12G          # default: the Docker engine's memory allocation minus 1G
  cpus: 8              # default: the engine's CPU count
  running_features: 3  # default: derived from memory and the registry's reservations
  installs: 2          # today's WERKMEISTER_INSTALL_SLOTS
  builds: 1            # today's single build lock
  playwright_runs: 1
  sessions: 6          # agent sessions outside Docker, see below
```

The defaults come from `docker info`, which reports the engine's total memory and
CPU count, so a fresh laptop needs no configuration.

**The cost of a feature** is the sum of its services' `memory_reservation` values plus
a fixed allowance for a build. Reservations are already in the registry and are the
right number for admission: they are what the containers need to run, while limits are
the ceiling for bursts, which the kernel enforces on its own.

**Admission.** `up` asks the host side for a lease covering the feature's cost. If
the budget has room, the lease is granted and containers start. If not, the feature
enters a **waiting** state with a queue position. The CLI either blocks and prints
progress, which is the default for an agent, or returns at once with a "queued"
message when `--no-wait` is given. `status` shows a Waiting column.

**Holding the session.** This is the part the request asks for and the part the code
is closest to already. `pause` holds a session by writing `paused.json`; the hook
installed on every tool call sees the file and denies the call with a reason. Source:
the `hooks_gen.ts` docstring, "While `paused.json` exists the same hook blocks every
tool call and prompt". The scheduler reuses that exact mechanism with a second file,
`waiting.json`, carrying the reason and the queue position. The agent sees "waiting
for capacity, position 2" on its next tool call, and the workspaces pane shows a
Waiting chip beside Working, Needs you and Done.

**Waking up.** A lease is released when the feature is stopped by any path: `stop`,
`down`, auto-stop at session end, the idle reaper, or the instruction every run
already carries to stop its containers right after `pr open` succeeds. Source:
`GATE_LINE` in `packages/werkmeister-core/src/run_start.ts`. On release, the host
side grants the next waiter, restarts its containers, removes `waiting.json`, and
nudges the session the same way `resume` does today.

**Preemption, within limits.** A person's interactive session outranks an autonomous
run, and a run that is at a human check outranks one that is idle. When a person's
`up` finds no room, the scheduler may stop the lowest-ranked autonomous feature, put
it in Waiting, and give the person its lease. Because pause does not free memory, this
preemption uses `stop`, never `pause`. `pause` stays as the tool for CPU contention
and for a person who wants a run frozen in place.

**Leases expire.** A lease carries the PID of the process that holds it and a renewal
deadline, so a crashed CLI does not hold capacity forever. This is the same
dead-holder check `packages/werkmeister-core/src/locks.ts` already does for its lock
files.

**Sessions count too.** Agent sessions run outside Docker, and the architecture doc
measures them at about 0.6 GB each. The scheduler cannot stop a person's session, but
it can answer "how many more can start" when the `next-wave` skill asks, so a wave
never starts more autonomous runs than the laptop has memory for.

### 3.3 What runs in parallel under this design

- As many features as fit the memory budget, with no fixed count.
- Installs and builds stay bounded as today, with builds allowed to rise to 2 on
  machines with 8 or more cores, since a build costs CPU rather than memory.
- One Playwright run at a time by default, since each is about 0.5 to 1 GB.
- The pre-PR gate's test runs count as usage, so the idle reaper never stops a
  feature mid-gate. That rule exists today through the `last-exec` marker.

### 3.4 Where it lives, and in what order

1. **A pure scheduler module**, `packages/werkmeister-core/src/scheduler.ts`, with
   no I/O: given a budget, the running features, the queue and a request, it returns
   a decision. This is the same shape as `idleFeatures` in `lifecycle.ts`, which is
   why it is testable without Docker.
2. **File-backed state first**, under `~/.werkmeister/scheduler/`, protected by the
   existing lock module. Wake-ups come from the existing 10-minute `pr watch` tick and
   from the release paths above. No daemon is needed for this step, so it can ship
   before section 2.
3. **The host side from section 2** then owns the state in memory and reacts at
   once rather than on a tick.
4. **CLI surface**: `budget show` and `budget set`, `up --wait` and `--no-wait`, a
   Waiting column in `status`, and the Waiting chip in the pane and dashboard.

---

## 4. Running on harnesses other than Claude Code

### 4.1 What is Claude Code specific today

This inventory comes from searching the core library for Claude Code's names and
paths. The counts are of matching lines per file.

| Area | What depends on Claude Code | Source |
|---|---|---|
| Workspace files | `CLAUDE.md`; hooks, permissions and model in `.claude/settings.json`; skills in `.claude/skills`; subagents in `.claude/agents`; `.mcp.json` | `claude_md.ts`, `hooks_gen.ts`, `workspace_skills.ts`, `agent_gen.ts`, `mcp_gen.ts` |
| Hook protocol | Event names `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`; tool names `Edit`, `Write`, `Bash`, `AskUserQuestion`, `ExitPlanMode`; environment variables `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_ENTRYPOINT`; the JSON shape on stdin and the deny shape on stdout | `hooks_gen.ts`, `agent_state.ts`, `stop.ts` |
| Session discovery | Live sessions from `~/.claude/sessions/*.json`; transcripts, titles and token usage from `~/.claude/projects/<cwd>/*.jsonl`; a price table keyed by Claude model ids | `lifecycle.ts`, `sandbox.ts` (62 matching lines) |
| Driving a session | `claude -p`, `claude -p --resume <id>`, `claude --continue`, `--disallowedTools`, `CLAUDE_BIN`; `claude://` links for Claude Desktop | `claude_cli.ts`, `sandbox.ts`, `register.tsx` |
| Machine setup | `claude plugin marketplace add` and `claude plugin install`; writing `~/.claude/settings.json` to allow reading the standards directory | `machine_setup.ts` (43 matching lines) |
| Permission rules | The `Bash(werkmeister up:*)` and `mcp__plugin_werkmeister_werkmeister__x` syntax | `hooks_gen.ts`, `docs/context-strategies.md` |
| The plugin | The plugin manifest, and the workspaces pane, which uses Claude Desktop's own pane and session tools | `plugins/werkmeister` |

Three things are already portable and should be named as such: the MCP server speaks
a standard protocol; the skills are plain `SKILL.md` folders; and the workspace
layout, the PR files and the lifecycle rules are Werkmeister's own files that any
program can read.

### 4.2 What other harnesses support, checked on 2026-10-28

- **Skills.** The `SKILL.md` format was published as an open standard at
  agentskills.io in December 2025. Secondary sources list Codex CLI, Gemini CLI,
  Cursor, GitHub Copilot, VS Code, Goose and Kiro among the tools that read it, and
  put the count above forty. The exact list should be confirmed on agentskills.io
  itself, since these are blog reports.
- **Hooks.** Cursor's own documentation describes `hooks.json` with events such as
  `beforeShellExecution`, a JSON-on-stdin protocol, and exit code 2 to block. Gemini
  CLI has `SessionStart`, `BeforeTool`, `AfterTool` and others in its settings JSON,
  per third-party documentation; Google's official page was not in the results. For
  Codex CLI the sources conflict: one says there are no hooks, later ones say hook
  events arrived in spring 2026 and were reworked in April. Treat Codex hooks as
  unsettled.
- **MCP.** All of the above support MCP servers. Codex also has a plugin format that
  bundles skills and MCP servers, from March 2026.

The practical conclusion: skills and MCP port cleanly. Hooks exist nearly everywhere
but with different event names, file locations and payloads, so they need a
translation layer per harness. Session discovery and headless driving have no
standard at all and differ per harness.

### 4.3 Proposal: a harness adapter, built the way context strategies already are

The codebase already solved a problem of this shape once. Two context layers, `jit`
and `icm`, sit behind one `ContextStrategy` interface in
`packages/werkmeister-core/src/strategies/types.ts`, and the rest of the code calls
`strategyFor` without naming either. The same pattern fits here.

Define `HarnessAdapter` in `packages/werkmeister-core/src/harness/types.ts`:

| Method | What it does | Claude Code adapter | Generic MCP adapter |
|---|---|---|---|
| `instructionsFile()` | The file the harness reads first | `CLAUDE.md` | `AGENTS.md` |
| `projectHooks(ws, hooks)` | Write Werkmeister's hooks in the harness's format | `.claude/settings.json` | nothing, reports "hooks unavailable" |
| `projectSkills(ws, skills)` | Where skill folders go | `.claude/skills` | `.agents/skills` or a configured path |
| `projectAgents(ws, agents)` | Subagent definitions, optional | `.claude/agents` | not supported |
| `projectMcp(ws, servers)` | Connect MCP servers | `.mcp.json` | the harness's config file |
| `projectPermissions(ws, rules)` | Allow and deny rules, optional | `permissions` in settings | nothing; enforcement is on the host side, section 2 |
| `sendTurn(ws, text)` | Headless one-turn message, optional | `claude -p --resume` | not supported |
| `usage(ws)` | Token and cost reading, optional | the transcript reader | not supported |

Hooks are defined once, abstractly, in core: `session-start`, `before-edit`,
`before-shell`, `after-tool`, `prompt-submit`, `session-end`, `agent-state`. The
adapter maps each to its harness's event name and config file, and ships a small
shim that turns that harness's stdin payload into one normalized shape before calling
`werkmeister internal hook <event>`. The hooks stay fail-open, as `agent_state.ts`
and `pr_guard.ts` are today.

Session liveness and agent state come from Werkmeister's own files, as section 2.4
proposes, so the generic adapter gets Working, Needs you and Done without reading any
harness's private directory.

The instructions file content is written once to `.werkmeister/instructions.md` and
projected to whatever name the adapter returns. The pane, dashboard and VS Code
extension keep reading Werkmeister's files, not the harness's.

The model field becomes a free string that the adapter validates, and the price
table becomes part of the Claude adapter's optional usage reader.

The Claude Code plugin and its Desktop pane stay as they are. They are the Claude
specific packaging, in the same way a Codex plugin would be the Codex packaging. The
skills they contain already live in the portable format.

### 4.4 In what order

1. **Extract the interface with one adapter**, Claude Code, equal to today's
   behavior. Move `claude_cli.ts`, `claude_md.ts`, the hook writer and the transcript
   reader under `packages/werkmeister-core/src/harness/claude/`. Tests pass unchanged.
   This is a refactor with no visible change.
2. **Add the generic MCP adapter**, which works on any harness that supports MCP and
   skills, with hooks reported as unavailable rather than silently absent. Together
   with section 2's host side, this is enough for an agent on Cursor or Gemini CLI to
   create a workspace, bring a feature up, and open a PR through the lifecycle.
3. **Add a hooks adapter per harness** as demand appears, Cursor first because its
   documentation is official and stable.

---

## 5. How the four fit together, and a suggested order

The four requests depend on one another more than they first appear to:

- The scheduler in section 3 needs somewhere privileged to live, which is the host
  side in section 2.
- The host side in section 2 needs session liveness to stop depending on Claude
  Code's files, which is the first step of section 4.
- The CLI regrouping in section 1 should land once the new verbs from sections 2 and
  3 exist, so the tree is reorganized once rather than twice.

Suggested order:

1. **Section 1, steps 1 and 2.** Commander 14, grouped help, `help.md` and man pages.
   Low risk, visible at once, no renames.
2. **Section 4, step 1.** Extract the harness interface with the Claude adapter.
   A pure refactor that unlocks everything after it.
3. **Section 2.** Per-workspace tokens, the `WERKMEISTER_HOST` client mode, session
   liveness in Werkmeister's files, the thin client package.
4. **Section 3.** The scheduler module, file-backed first, then in the host side.
5. **Section 1, step 3.** The noun groups and aliases, now including `budget`,
   Waiting, and the `internal` group.
6. **Section 4, steps 2 and 3.** The generic adapter, then per-harness hooks.

## 6. Questions only the owner can answer

1. **Is the `w9r` short form expected to keep the everyday verbs at the top level
   forever?** The proposal says yes. If not, the alias list in 1.3 shrinks.
2. **How long is the deprecation window for old command spellings?** The frozen
   surface rule in `CONVENTIONS.md` suggests at least several minor releases.
3. **Should the agent-in-container shape become the default in `setup`**, or stay an
   opt-in? The security argument in `docs/docker-socket-replacement.md` says default;
   the laptop convenience argument says opt-in.
4. **What is the right default budget on a 16 GB laptop?** The measured numbers in
   the architecture doc suggest two features with two services each. That needs
   measuring with the scheduler in place rather than guessing.
5. **Does preemption of autonomous runs by a person's session match how you work?**
   It can be turned off, but the default has to be chosen.
6. **Which second harness matters first?** Cursor has the most stable hook
   documentation; Codex has the plugin format closest to Claude Code's.
