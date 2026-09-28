# Known Issues

Tracked concurrency and isolation issues in the sandbox.

---

## Sandbox Env Vars in `.zshrc` Are Invisible to Non-Interactive Shells

**Severity:** Moderate (breaks tooling, easy to misdiagnose)
**Status:** Resolved by tooling — `sandbox config` writes `~/.zshenv` for you
**Affects:** Shell setup / installation (`SANDBOX_WORKSPACES_ROOT`, `SANDBOX_ROOT`)

`sandbox config` now manages a marked block in `~/.zshenv` that sources
`~/.sandbox/env.sh` (`zshenvPath()` / the managed-block markers in
`packages/sandbox-core/global_config.ts`), and strips the old hardcoded exports it
finds there. So a fresh install no longer hits this. The rest of the entry is kept
because the failure is still the first thing to check when a *hand-configured*
machine behaves differently under an agent than in your terminal.

The common install instruction is to `export SANDBOX_WORKSPACES_ROOT=...` (and
`SANDBOX_ROOT=...`) from `~/.zshrc`. But `~/.zshrc` is sourced **only by
interactive shells**. Any *non-interactive* shell — Claude Code's Bash tool,
cron jobs, CI runners, editor "run task" integrations, MCP servers — sources
`~/.zshenv` instead and never sees these exports.

**Symptoms:**
- `sandbox init-workspace` (or other `sandbox` subcommands) run by an agent or
  automation fails with:
  `[err]  Not inside a sandbox workspace (checked: /Users/<you>/workspace) and no parent .git directory found.`
  even though it works fine when *you* run it in your terminal.
- The CLI falls back to the default `~/workspace` because
  `SANDBOX_WORKSPACES_ROOT` is unset in that shell, so it can't locate
  workspaces kept elsewhere (e.g. `~/.vibe-kanban-workspaces`).

**Root cause:** Zsh startup-file scoping. `~/.zshenv` → all shells;
`~/.zshrc` → interactive only.

**Fix (install-time):** Put the sandbox exports in `~/.zshenv`, not `~/.zshrc`:

```sh
# ~/.zshenv
export SANDBOX_WORKSPACES_ROOT="$HOME/.vibe-kanban-workspaces"  # or ~/workspace
export SANDBOX_ROOT="$HOME/workspace/sandbox"
```

Note `SANDBOX_ROOT` is also re-derived by the `sandbox` launcher script itself
(`readlink -f $0`), so the `sandbox` CLI works without it — but other tooling
and `docker compose` interpolation may rely on the exported value, so set it in
`.zshenv` for consistency.

**Workaround (one-off):** Prefix the invocation with the var, e.g.
`SANDBOX_WORKSPACES_ROOT="$HOME/.vibe-kanban-workspaces" sandbox init-workspace`.

---

## Environment Placeholder Syntax in services.yaml

**Severity:** Moderate (functional bug)
**Status:** Resolved — the file that carried them no longer ships
**Affects:** the service registry (now `~/.sandbox/services.yaml`)

Several service environment variables in the repo's shipped `infra/config/services.yaml` used `{service-name}` placeholders:

```yaml
BACKEND_URL: "http://{backend}/api"
```

Those rendered verbatim into Docker Compose environment blocks — literal curly braces are neither valid hostnames nor Compose variable syntax (`${...}`).

**Why it is closed:** the registry is machine-global and user-owned now (`~/.sandbox/services.yaml`, seeded by `sandbox setup` from `renderServicesYaml`), and the seed contains no such placeholders — verified against the rendered output. `infra/config/services.yaml` no longer exists.

A hand-written placeholder in a user's own registry is still handled: `resolveServiceRefs()` in `packages/sandbox-core/generate.ts` resolves `{service-name}` to the Docker DNS alias, and the compose generator builds its own `*_URL` variables from those aliases rather than from the registry string.

---

## k8s Port-Forward PID Tracking (Legacy Fallback)

**Severity:** Low
**Status:** Resolved

The legacy in-process fallback and bash script PID management are no longer used. k8s port-forwards now run inside a Docker container (`k8s-forwards`) managed by Docker Compose with built-in health checks and auto-restart, eliminating the PID tracking problem entirely.

This resolves *PID tracking*, not *liveness* — the container's healthcheck cannot tell a live forward from a dead one. See the next section.

---

## k8s Port-Forwards Report Healthy While Dead

**Severity:** Moderate (cost more than one debugging session)
**Status:** Fixed — the probes speak the protocol
**Affects:** `sandbox-k8s-forwards`; anything reaching Redis/Postgres through it, host tests included

A stale `kubectl port-forward` accepts the TCP connection and then never replies, so anything
that stops at "connected" reports a dead datastore as healthy. Both checks used to stop
there: the compose healthcheck (`nc -z localhost 9050 && 9051`) and the entrypoint's own
45s monitor, which is what restarts a broken forward — so nothing noticed, and nothing
self-healed.

The symptom is misleading: every frontend test hangs ~50s in `beforeEach` **with no mention
of Redis at all**. demo-services' suite names this exact case ("Redis accepts the connection
but never replies").

Each forward now gets the probe its `health_endpoint` names — `redis-cli ping`, `pg_isready`,
an HTTP GET, or a bare connect for anything that names nothing
([probe.sh](../apps/cli/infra/compose/k8s-port-forward/probe.sh)). The entrypoint's monitor
and the compose healthcheck both call it, so a dead forward is restarted within ~45s and
reads unhealthy until it is. `sandbox status` and the dashboard use the matching
`checkWireHealth` in sandbox-core.

**If it hangs anyway** (a forward wedged inside that 45s window, or a datastore that names
no probe):

```bash
docker exec sandbox-k8s-forwards /usr/local/bin/probe.sh   # per-forward verdicts
docker restart sandbox-k8s-forwards                        # healthy again in ~12s
```

---

## Standalone Mode Source Code Sharing

**Severity:** Low (by design)
**Status:** Won't fix — documented limitation
**Affects:** Standalone workspace mode (`~/workspace/`)

In standalone mode, all features share the same source code checkout. Two features modifying the same repo will see each other's uncommitted changes via bind mounts. Docker volumes (`node_modules`, build caches) are properly isolated per-feature, but the source code is shared.

**Workaround:** Use per-feature workspaces (`SANDBOX_WORKSPACES_ROOT`) for true concurrent multi-feature development. Each feature gets its own git worktree.

---

## Proxy UI Cookie Scope

**Severity:** Low (by design)
**Status:** Won't fix — documented behavior
**Affects:** `apps/cli/infra/proxy/ui/index.html`

The `X-Feature` cookie is set with `path=/`, meaning it applies to all tabs in the same browser. Users testing multiple features simultaneously need separate browser profiles or use the `X-Feature` HTTP header directly (e.g., via ModHeader browser extension).

**Easiest workaround:** `./sandbox open <feature>` launches an isolated incognito Chrome (its own throwaway profile) with the cookie already set and the window tagged `[feature]`, so each feature gets its own window with no cookie collision.

---

## Orphaned Per-Feature Volumes on Teardown

**Severity:** Low
**Status:** Resolved
**Affects:** `packages/sandbox-core/compose.ts` — `composeDown()`

`sandbox down` preserves per-feature Docker volumes by default (for faster subsequent startups). Use `sandbox down --volumes` to remove them, or `sandbox clean` to bulk-remove orphaned volumes from stopped features.

---

## Caddy `handle` vs `route` Directive — Silent Route Dropping

**Severity:** Critical (causes blank pages / empty responses)
**Status:** Resolved — documented to prevent recurrence
**Affects:** `apps/cli/infra/proxy/Caddyfile`, `apps/cli/infra/templates/Caddyfile.njk`, `packages/sandbox-core/generate.ts`

When the Caddyfile uses multiple `handle` blocks at the same nesting level for path-based routing, Caddy groups them into a **mutual-exclusion set**. Only the first matching `handle` block executes; the remaining blocks are silently dropped from the compiled config. This results in URLs returning HTTP 200 with `content-length: 0` (empty body) for any path whose route was dropped.

**Symptoms:**
- Page loads but is completely blank (empty response body)
- `curl` returns `HTTP 200` with `Size: 0` through Caddy, but works fine when hitting the service directly
- `caddy adapt` output shows fewer routes than expected (e.g., 13 instead of 24)

**Root cause:** Caddy's `handle` directive creates mutually exclusive route groups. Multiple `handle` blocks at the same level compete, and routes after the initial set get dropped.

**Fix:** Always use `route { ... }` for ordered path-based routing. Inside `route`, matchers are evaluated in order without mutual exclusion:

```caddy
# WRONG — routes silently dropped:
handle /path-a/* { reverse_proxy backend1 }
handle /path-b/* { reverse_proxy backend2 }
handle { reverse_proxy catchall }

# CORRECT — all routes preserved:
route {
    @a path /path-a/*
    reverse_proxy @a backend1
    @b path /path-b/*
    reverse_proxy @b backend2
    reverse_proxy catchall
}
```

**Verification:** After any Caddyfile change, validate with `caddy adapt` and count compiled routes. If the count is lower than expected, routes were dropped.

**What ships today** is not the `route { }` form above: the generator emits path-scoped `handle`
blocks (`handle @<feature>`, `handle /*`, `apps/cli/infra/templates/Caddyfile.njk`), which do
not collide the way a bare `handle` beside scoped ones does. Two guards hold that shape:
`reloadCaddy` counts the compiled routes before switching (`packages/sandbox-core/caddy.ts`),
and `apps/cli/src/lib/__tests__/caddy_lint.test.ts` pins the bare-vs-scoped structure.

---

## Docker Desktop VirtioFS File Sync Lag

**Severity:** Moderate (causes stale configs)
**Status:** Open — inherent to Docker Desktop
**Affects:** `apps/cli/infra/proxy/Caddyfile` (bind-mounted into `sandbox-caddy` container)

Docker Desktop's VirtioFS file sharing may not sync bind-mounted files immediately after writes on the host. The `apps/cli/infra/proxy/Caddyfile` file may show different sizes when compared between host and container, causing Caddy to use stale or truncated config.

**Symptoms:**
- `caddy adapt` reports `unexpected EOF` after editing Caddyfile
- `wc -l` shows different line counts on host vs inside container
- Caddy reload appears to succeed but config doesn't change

**Workaround:** Always use `docker cp` to push the file, then reload from the copied path:

```bash
docker cp apps/cli/infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile
docker exec sandbox-caddy caddy reload --config /tmp/Caddyfile
```

Do not rely on the bind mount at `/etc/caddy/Caddyfile` syncing in real-time for reloads.

---

## Workspace-Create Form Duplicated Across Desktop and Browser Surfaces

**Severity:** Low (deliberate; tech debt)
**Status:** Resolved — the two surfaces share one form
**Affects:** `apps/sandbox-dashboard/src/mcp-app.ts` (Desktop MCP App), `apps/sandbox-dashboard/src/create-form.ts` (browser dashboard "New workspace" tab)

`mcp-app.ts` imports `initCreateForm` from `create-form.ts` — the optimization pass below happened, and the ~120 duplicated lines are gone. The history is kept because the *reasoning* about why a naive share was not free still applies to the next surface that wants this form (claudeck's `create-form.mjs` is a third, independent one; see "Claudeck's Streaming Routes Still Spawn the CLI" below for the general shape of that problem).

<details>
<summary>The duplication as it stood, and the pass that removed it</summary>


The RJSF workspace-create form is implemented twice — `WorkspaceForm`, `TextareaWidget`, `validateRepoSelection`, and `transformErrors` are duplicated (~120 lines, mostly identical) between the two surfaces. This is intentional for now: the browser dashboard is under active construction, and sharing would couple a churning surface to the shipping Desktop one, so an experiment on the browser form could regress Desktop.

The four genuine differences (why a naive share isn't free) are all host-level: transport (ext-apps `app.callServerTool` returning `CallToolResult` vs `bridge.callTool` throw-on-error), post-submit side effect (`updateModelContext` vs `onCreated`), styling (TR brand vs neutral list palette), and bootstrap (host pushes bundle via `ontoolresult` vs self-fetch in `initCreateForm`).

**Optimization pass (do after the browser dashboard stabilizes):**
1. `validateRepoSelection` and `transformErrors` are **byte-identical and host-agnostic** (pure, no `app`/`bridge`) — lift them into `lib/` and import in both. Zero regression risk; safe to do even before the browser surface settles.
2. Once the browser form stops moving, extract a shared `<WorkspaceForm callTool={…} />` component, threading the four host differences above as props/config, and have both entrypoints render it.
</details>

---

## Claudeck's Streaming Routes Still Spawn the CLI

**Severity:** Low (works; costs a process launch per action and diverges from the other consumers)
**Status:** Open — unblocked; the claudeck routes have not been moved yet
**Affects:** `apps/claudeck/plugins/sandbox-workspace/server.js` — `POST /action`, `POST /intercept`

`sandbox-core` never spawns the `sandbox` CLI (note 087), but a **consumer** may, and claudeck
still does for two of its routes. The dashboard and the VS Code tree call core in-process for
the same data, so the surfaces disagree about how they reach the same work.

Two of claudeck's four spawns are already gone (note 093): the intercept read became
`getIntercepts()` — `GET /docker` went from ~5.5s to ~230ms, since the CLI boot was the whole
cost — and `POST /open` became `openFeatureBrowser()`, which also made launch failures visible
instead of answering `200 {"ok":true}` and doing nothing.

The two that remain both **stream** the child's output to a chunked response, ending on
`[exit N]`:

| Route | Spawns | Core equivalent |
|---|---|---|
| `POST /action` | `sandbox up\|stop\|restart\|down` | `runWorkspaceAction(name, action)` |
| `POST /intercept` | `sandbox intercept -s <svc> [--leave]` | `startIntercept(...)` / `leaveIntercept(...)` |

**`/action` is no longer blocked either.** Both of its stated blockers are gone:

1. `runWorkspaceAction` still collects a transcript rather than streaming one, but the seam was
   always there — `collectingReporter(onChunk)` in `packages/sandbox-core/reporter.ts`, which
   `POST /create` in this same file already uses through `createWorkspace`'s `onData`. Roughly
   three lines.
2. **Cancellation was the decision, and it was made.** `up`, `down`, `connect`, `logs`, `test`
   and the intercept pair now take an optional `AbortSignal`, forwarded to an async spawn
   (`runAsync` in `packages/sandbox-core/proc.ts`). `res.on("close")` can abort one, which is
   what the killed child used to provide.

**What is left is a claudeck change, deliberately out of the migration's scope:** rewiring the
two routes to call core in-process instead of spawning. Nobody has done it.

**`/intercept` is no longer blocked.** `startIntercept` and `leaveIntercept` in
`packages/sandbox-core/telepresence.ts` are the command body, callable in-process: every failure is
a coded `SandboxError` (`NOT_LOCAL`, `NOT_INTERCEPTABLE`, `TELEPRESENCE_VERSION`, `NOT_RUNNING`,
`PORT_CLOSED`, `INTERCEPT_FAILED`) rather than the `process.exit(1)` that would have taken the
express server down, and both spawn through `runAsyncRunner` (`runAsync`) instead of `spawnSync`,
so a slow `telepresence connect` holds one request rather than the whole event loop. Both take
`localServices: string[]` — the caller reads the workspace `.env`, since a `.env` walk-up is a cwd
concern core will not have.

**Actually moving the route is a claudeck change and out of the core migration's scope.** What it
still needs on claudeck's side: the reporter's `info` progress lines (`Connecting to …`,
`Intercepting …`) come back through `collectingReporter(onChunk)`, exactly as `POST /create`
already does; the "Intercept active" block is CLI rendering that the route would replace with
`InterceptResult` fields; and `signal` is available for abort-on-disconnect, unlike `/action`.

**Also worth knowing when this is picked up:** the telepresence reads behind `getIntercepts()`
are still `spawnSync`, so they block the caller's event loop — the whole express server, not just
the waiting request. They run under a 15s cap (`STATUS_READ` in `packages/sandbox-core/status.ts`)
for exactly that reason; `listIntercepts`, `connectedNamespace` and `leaveFeatureIntercepts` were
deliberately left synchronous. Anything else moved in-process should be checked the same way.

---

## `getFormSchema()` Scans Your Home Directory for a Jira ID It Discards

**Severity:** Low (wasted work and a surprising `git` call, not a wrong result)
**Status:** Resolved — the create form opts out of defaults
**Affects:** `packages/sandbox-core/sandbox.ts` — `getFormSchema()`, via `scrapeJiraId` in `workspace_prompts.ts`

`getFormSchema()` now calls `computePromptSpec({}, os.homedir(), { defaults: false })`, and
`promptEntry` in `workspace_prompts.ts` skips every prompt's `defaultFn` under that flag, so the
scan never runs. `sandbox workspace --print-prompts` is unchanged: it runs against the cwd and
still wants the defaults.

The workspace-create form is built against `os.homedir()`, deliberately: a stray
`./.sandbox/workspace.yml` under the caller's cwd must not pre-resolve fields for a
brand-new workspace. But building the prompt spec evaluates every prompt's `defaultFn`, and
`jira_id`'s is `scrapeJiraId(workspaceRoot)` — which lists that root and runs
`git branch --show-current` in **every non-dot subdirectory**, looking for a ticket key.

The result is then thrown away: `formData` starts blank on purpose, so a derived value can't
be submitted by accident.

**Cost:** ~343ms per call on a home directory with 18 non-dot entries, most of it those `git`
invocations — paid every time a surface loads the create form (Desktop MCP app, browser
dashboard, claudeck).

This behaviour predates the migration — the spawned CLI did exactly the same thing with the
same cwd — but it is core's now, and visible.

**Fix:** skip the `defaultFn` evaluation for a root that is not itself a workspace, or let
`buildPromptSpec` take a "defaults not wanted" flag for the create-form path. Either removes
the scan without changing what the form shows.

---

## Session-Start Notes Context Is Unbounded Against a 10k Truncation

**Severity:** Moderate (silently drops the newest decisions, which is the opposite of what you want)
**Status:** Resolved — the decision list is budgeted, newest first
**Affects:** `apps/cli/src/commands/notes.ts` — `buildContext()`, via the SessionStart hook

`buildContext()` now renders decisions into a `_CONTEXT_CHAR_CAP` (9000 chars) budget, keeping
the newest and listing the elided older ones by path so a session can still read them
(`renderDecisions` in `apps/cli/src/commands/notes.ts`). Standards and the handoff always print.

`buildContext()` renders the latest handoff plus **every** open `decision` note. The hook
harness truncates its combined output at ~10k characters — the function's own docstring says
so, and orders standards first to protect them — but nothing bounds the decision list. A
workspace that accumulates decisions therefore pushes its newest ones past the cutoff.

**Symptom:** a decision recorded in one session is not in the next session's context, so the
same ground gets re-litigated. Observed directly: a SessionStart hook in this repo emitted
**110.8KB**, eleven times the budget, with 57 notes marked `status: open`.

**Why it bites the wrong end:** decisions render after the handoff, so the ones cut are the
most recently written — exactly the ones a fresh session needs.

**Fix options:** cap the number of decisions rendered (newest first) and say how many were
elided; or make `status:` retirement real so "open" means "still binding" rather than "not
superseded"; or render decision *titles* with paths, and let the session read the ones it
needs.

---

## One Machine-Global `sandbox_root`, and Generated State Inside the Package

**Severity:** Moderate (two checkouts silently fight; an upgrade can discard local state)
**Status:** Open — deferred, blocked on a decision about where generated state lives rather than on effort
**Affects:** `~/.sandbox/config.yaml` `paths.sandbox_root`, `apps/cli/infra/`

`sandbox_root` is a single machine-global pointer at one CLI checkout (here,
`/Users/jayboyer/repos/sandbox/apps/cli`). It ranks above the walk-up in `resolveSandboxBin`
and is what `infraRoot()` resolves from — so **whichever install ran `sandbox config` last
wins**, and a second checkout (or a feature worktree, or an `npx` install) silently starts
serving `infra/` out of the other one.

Compounding it, generated state lives *inside* that package tree rather than beside the
user's config: `apps/cli/infra/proxy/Caddyfile` and `apps/cli/infra/proxy/ui/features.json`
are both gitignored build products under a directory that ships in the published package.
Reinstalling or upgrading `@jbbz-sandbox/sandbox-cli` can therefore discard or stale them.

**Fix direction:** generated artifacts belong under `~/.sandbox/` (like `services.yaml` and
`ports.yaml` already do), leaving the package tree read-only; `sandbox_root` then only has to
locate templates, not mutable state.

---

## Generated CLAUDE.md Task Title Competes With the Starting Prompt

**Severity:** Moderate (wastes the first agent turn on every workspace)
**Status:** Open
**Affects:** `sandbox workspace` / `sandbox init-workspace` (`--task`, `--description`, `--starting-prompt`), the CLAUDE.md template, `sb-research`

Observed in the JIT-vs-ICM comparison run of 2026-09-27 (`jit-ws2`, claude-sonnet-5, headless `claude -p`; per-turn JSON in `~/features/runs/jit-ws2/`, write-up in `~/features/COMPARISON.md`).

The workspace was created with `--task "JIT workspace test (run 2)"`, `--description "Test the JIT context management system for this workspace."` and a 700-word `--starting-prompt` describing the real job (OpenAPI docs for `apps/backend`). The generated CLAUDE.md renders task + description under "Current Task"; the starting prompt lands only in `.sandbox/notes/001-handoff-starting-prompt.md`. On the first message ("Start the task in this workspace.") the agent read both, treated them as two different tasks, and stopped to ask which one to do:

> CLAUDE.md's "Current Task" says this is `jit-ws2` — "JIT workspace test (run 2)…". The handoff note describes a different, more substantial task… Which do you want me to do right now?

One full human round-trip before any work, on a workspace with no ambiguity from the operator's point of view. The ICM sibling (`icm-ws2`), whose entry file points at a single `BRIEF.md`, did not ask.

**Likely fix:** treat `--task` as a title for the starting prompt, not a peer of it — render the handoff note's goal (or its first heading) as the Current Task, and drop `--description` from the agent-facing CLAUDE.md (it is dashboard metadata). Alternatively, have `sb-research` step 0 state that the handoff note *is* the task and the CLAUDE.md line is its label.

**Fix (partial):** `docs/superpowers/specs/2026-09-27-work-type-phases.md`. The seeded handoff
and CLAUDE.md now name the phase and artifact to start with, which is what the run-2 model
asked about. The task-title-vs-prompt conflict itself is unchanged; this entry stays open.

---

## Answers Given in Chat Are Not Persisted, So Later Phases Re-Ask

**Severity:** Moderate (duplicate human round-trips; a gate that cannot see its own inputs)
**Status:** Open
**Affects:** `sb-research`, `sb-implement`, `sb-pr` (pre-PR gate), the notes ledger conventions

Same run as above. Turn 2 answered all six open questions from the handoff note in chat, including "Jira key: none — there is no ticket". `sb-research` then wrote `002-finding-openapi-docs-research.md` (routes, tooling, frontend cross-check) but recorded none of the answers. `sb-implement` wrote `003-decision-openapi-implementation-choices.md` for its own four follow-up questions, again without the Jira answer. Two turns later, `sb-pr`'s gate read handoff note 001 ("Jira key was not provided — ask before doing anything"), found no note contradicting it, and asked again:

> Do you have a Jira ticket key for this work? … that question was never answered in this session either.

The answer existed in the same session's context but not in the ledger, and the ledger is what the phase skills consult. Cost: one extra human turn and a third `sb-pr` pass (~32 API turns, ~1.4M input tokens).

**Likely fix:** `sb-research` (or whichever phase asks the handoff's open questions) must write a `decision` note with the answers as soon as they arrive — the handoff note's "Open questions" block is the natural source, its answers the natural `decision`. `sb-pr` should read `decision` notes before re-asking anything the handoff marked open.

**Related:** `sb-implement` asked four more design questions (validator dependency, drift-test style, `/health` method, Dockerfile COPY) after research had already gathered every fact needed to decide them. Not a bug, but it doubled the human turns relative to the ICM sibling, which proposed answers with evidence in a file for the human to flip to `decided`.

**Fix:** `docs/superpowers/specs/2026-09-27-work-type-phases.md`. `sb-research` now ends a
`feature` in a `decision` note with `status: decided` recording the answers, `sandbox notes
context` re-injects it every session, and the phase gate blocks source edits until it exists.
Confirm with a jit-ws2 rerun before closing.

---

## Phase Gate Rough Edges

**Severity:** Low (each fails open or is cosmetic; none blocks a correct workspace)
**Status:** Open
**Affects:** `packages/sandbox-core/gate.ts` (`decide`, `_noteStatus`), `packages/sandbox-core/workspace_skills.ts` (`checkStandardsManifest`), `docs/jit-context-system.md`, `docs/known-issues.md`

Left over from the final review of the work-type phase gate
(`docs/superpowers/specs/2026-09-27-work-type-phases.md`):

| Where | What |
|---|---|
| `gate.ts:290` — `decide()` | The phase-gate step runs after `_loadState`, so an unreadable `.sandbox/.gate/<session>.json` returns null and **silently disables the phase gate** too, although the phase gate uses no state. Fix: move the phase-gate block above `_loadState`. |
| `gate.ts:207` — `_noteStatus()` | `status:\s*` can run past the newline, so an empty `status:` line captures the next line's first token as the status. The result matches "no status" today (that token is never `decided`/`superseded`), but `[ \t]*` would be exact. |
| `gate.ts:203` — `_noteStatus()` | A note whose frontmatter is an empty `---`/`---` block does not match the block regex, counts as unparseable, and fails open, so it satisfies a `decided` gate. Fail-open is deliberate for unparseable notes; an empty block is arguably "no status" instead. |
| `workspace_skills.ts:324` — `checkStandardsManifest()` | Reads `.sandbox/standards.json` twice per call: once in `resolveWorkspaceManifest` to see whether a gate exists, and once for `onDisk`. CLI path only, not the per-edit gate. |
| Gate latency | The 79ms measurement (50 notes) exited on the first matching note. The worst case, a `decided` gate with many `open` decision notes that reads every file, was not timed. |
| Cosmetic | `gate.ts:297` labels the step "2a" while `jit-context-system.md` §6 numbers it 2; the §5.3 work-type paragraph is wrapped wider than its neighbours; in "Answers Given in Chat" above, the **Fix:** paragraph follows **Related:** rather than **Likely fix:**. |

---

## Library Rough Edges Left by the CLI-to-Core Migration

**Severity:** Low (each is small; they share a cause)
**Status:** Resolved — the library reports failure, drops the flag name, and reconciles hooks on `up`
**Affects:** `packages/sandbox-core/{compose,lifecycle,hooks_gen}.ts`

`composeDown()` returns false when `docker compose down` fails (true only for a feature with no
compose file, which it now checks itself), and `lifecycle.down`, `sandbox remove`, and
`sandbox clean` warn on it. The volumes line reads "Per-feature Docker volumes will be removed".
`lifecycle.up` calls the workspace strategy's `refresh` on every `sandbox up` (which for `jit`
re-merges the hooks), so a stale hook is reconciled the next time the feature starts.

Code that used to be a CLI command and is now a library function still reads like a command
in three places:

| Where | What |
|---|---|
| `compose.ts` — `composeDown()` | Returns a success `boolean` that **all three callers discard** (`lifecycle.ts:381`, `commands/remove.ts:72`, `commands/clean.ts:119`). A teardown that failed is indistinguishable from one that worked. |
| `lifecycle.ts:377` | Emits `info("--volumes: per-feature Docker volumes will be removed")` — a **CLI flag name** in library output, so the dashboard and claudeck show a flag their user never typed. |
| `hooks_gen.ts` — `writeWorkspaceHooks()` | Called only from `initWorkspace`. A workspace created before a hook-template change keeps the stale hook until someone re-runs `sandbox init-workspace` there by hand; nothing reconciles it. |

---

## A Feature Browser Window Outlives Its Launcher, and Its Profile Leaks

**Severity:** Low (a directory in `$TMPDIR`, swept by the OS)
**Status:** Open — inherent to launching in-process
**Affects:** `packages/sandbox-core/browser.ts` — `FeatureWindow.supervise()`

`launchFeatureWindow` spawns the browser `detached`, so the window survives its caller — the
point, for the MCP server's open-feature tool, which returns while a human keeps the window.
Cleanup (kill the browser, remove the throwaway `--user-data-dir`) lives in `supervise()`'s
`finally`, which only runs if the caller is still alive when the window closes.

So a long-lived caller that exits first — an MCP server restart, say — leaves the profile
directory behind. The spawned `sandbox open` child this replaced owned its own cleanup and
did it regardless.

**Not a leak of anything sensitive:** the profile is a throwaway created per launch under
`$TMPDIR`. **Fix direction:** sweep stale `chrome-<feature>-*` directories on the next launch,
which is cheap and needs no supervisor.

---

## VS Code Extension Manifest Is Missing `repository` and `license`

**Severity:** Low (blocks a clean Marketplace publish)
**Status:** Open
**Affects:** `packages/vscode-plugin/package.json`

Neither `repository` nor `license` is set, and there is no `LICENSE` file in the package.
`vsce package` warns on both, and the Marketplace listing renders without a source link.

**Fix:** add `"repository": { "type": "git", "url": "https://github.com/jbbz-sandbox/sandbox.git", "directory": "packages/vscode-plugin" }`, set `"license"`, and add the LICENSE file.

---

## `compose-logs.smoke.mjs` Fails When Run From Inside a Workspace

**Severity:** Low (a false red on `npm test`; CI's clean checkout never hits it)
**Status:** Open
**Affects:** `packages/sandbox-core/compose-logs.smoke.mjs`; `workspaceForFeature()` in `packages/sandbox-core/compose.ts`, via `resolveWorkspace()` in `config.ts`

The smoke's last assertion is that `composeLogsStream("no-such-feature-hopefully")` returns
`null`. It does not when the test runs from a checkout that sits under `paths.workspaces_root`
(a feature worktree, say): `composeFile()` finds no container for that feature and falls back
to `resolveWorkspace()`, whose cwd branch returns `<workspaces_root>/<first path segment>`
**regardless of the feature name** (`config.ts:295-306`). That workspace has a
`docker-compose.yml`, so a child is spawned and the assertion fails.

**Symptom:** `npm test` at the repo root ends with `sandbox-core#test` failed and
`expected null rather than a doomed child when the feature has no compose file`, while the
`node --test` suite before it reports `fail 0`. The same script passes from a neutral cwd.

**Workaround:** run the smoke (or `npm test`) from a directory outside `workspaces_root`.

**Fix direction:** have the smoke `chdir` somewhere neutral before the negative case, or make
`workspaceForFeature`'s fallback confirm the resolved directory actually belongs to *feature*
before trusting it.

---

## `npm test` Regenerates the Caddyfile and Reloads a Running Caddy

**Severity:** Low (idempotent, but a unit-test run should not touch live infrastructure)
**Status:** Fixed 2026-09-04 — both tests are hermetic and no longer skip
**Affects:** `packages/sandbox-core/lifecycle-proxy.test.mjs`, `packages/sandbox-core/lifecycle-clean.test.mjs`

Both called the real `reloadProxy()` / `planClean()` rather than a seam. On a configured
machine, running the core suite regenerated `infra/proxy/Caddyfile` from whatever features
happened to be up and — if Caddy was running — reloaded it. Idempotent, and the file is
gitignored, so nothing was lost; but a `npm test` that briefly bounces your proxy is a
surprise, and it cut against this package's own line that real API calls are integration
rather than unit territory (`docker.test.mjs` says so explicitly).

**The fix**, along the direction this entry named. `reloadProxy` takes a trailing
`ops: ProxyOps = REAL_PROXY_OPS` — the same shape and reason as `telepresence.ts`'s
`runner: Runner = _run`, so no caller passes it. It is the whole boundary rather than a
caddy runner alone because `getAllSlots` reads Docker container labels: faking the proxy
half and not the slot half would still have needed a live daemon.

`planClean` needed no seam. In dry-run it removes nothing — it never reaches the
`generateCaddyfile`/`reloadCaddy` branch, which is guarded by `!dryRun` — so its only
problem was reading the developer's real Docker state. Its one real decision, the
kept-vs-orphaned split, is now `classifyVolumes` in `lifecycle.ts`, tested directly the way
`featureFromVolume` beside it already was.

**What this bought.** The two files went from 6 tests, 4 of them skipped on any machine
without `~/.sandbox` (which is every CI run), to 15 tests that always run. Several assert
branches a real machine reached only by luck: `started` can only be true with Caddy down, so
on a developer box running Caddy the old test passed either way, and the "no live feature's
volume is proposed for removal" property asserted nothing at all on a machine with no
features up. `machineConfigured()` in `fixtures.mjs` had no callers left and is gone.

**Verified:** `md5` of `apps/cli/infra/proxy/Caddyfile` is unchanged across a full
`packages/sandbox-core` run, and both files pass under an empty `HOME`.

**A related trap, already fixed:** both files used to pin `process.env.SANDBOX_ROOT` to their
own checkout. Without that, a shell exporting `SANDBOX_ROOT` (which `~/.sandbox/env.sh` does)
made the tests write **the shared checkout's** `infra/proxy/Caddyfile` when run from a git
worktree — an isolated agent silently mutating the main working tree. Neither file resolves a
path any more, so both pins are gone with the hazard.

---

## Core Tests Must Be Hermetic: CI Has No `~/.sandbox`

**Severity:** Moderate (nine tests merged green locally and red on CI)
**Status:** Resolved — `fixtures.mjs` provides the seam
**Affects:** `packages/sandbox-core/*.test.mjs`

`loadServices()` / `loadPorts()` **throw** `Required config file not found` on a machine with
no `~/.sandbox/{services,ports}.yaml` rather than returning empty. A CI runner is exactly that
machine. So any core test that reaches the registry — directly, or through `getSlot`,
`classifyEndpoint`, `detectReport`, `removeService`, `checkStandards` — passes on a developer
box and fails on CI.

Nine did, in one PR. Every one of them was written against "run
`npx turbo run typecheck build test`", which is green locally and proves nothing about a clean
machine. The pre-existing core tests were all hermetic, which is why this had never bitten.

**The seam:** `SANDBOX_CONFIG_FILE` relocates the whole `~/.sandbox` set (see `configPath` in
`config.ts`). `withSandboxHome(fn)` in `packages/sandbox-core/fixtures.mjs` seeds a temp home
with a minimal `config.yaml`, `services.yaml` and `ports.yaml`, runs `fn`, and restores.

**Before merging a core test, run it against an unconfigured machine:**

```sh
cd packages/sandbox-core
EMPTY=$(mktemp -d) SANDBOX_CONFIG_FILE="$EMPTY/.sandbox/config.yaml" node --test *.test.mjs
```

A test that genuinely needs a live stack should skip on `machineConfigured()` rather than
borrow the developer's registry.
