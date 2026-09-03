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
**Status:** Open — deferred, blocked on two decisions rather than on effort
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
| `POST /intercept` | `sandbox intercept -s <svc> [--leave]` | none yet |

**What blocks `/action`** — two things, only one of which is code:

1. `runWorkspaceAction` collects a transcript rather than streaming one. The seam exists —
   `collectingReporter(onChunk)` in `packages/sandbox-core/reporter.ts`, which `POST /create` in
   this same file already uses through `createWorkspace`'s `onData` — so this is roughly three
   lines.
2. **Cancellation, which is a decision, not a task.** The child process gives claudeck a
   10-minute `SIGKILL` timer and abort-on-disconnect (`res.on("close")` kills it). An in-process
   run has neither: a wedged `docker compose up` would hold a server request with no way to end
   it. Either the lifecycle functions grow an `AbortSignal`, or that behaviour is knowingly
   dropped.

**What blocks `/intercept`:** there is no core entry point at all. `packages/sandbox-core/telepresence.ts`
has the pieces (`buildInterceptArgs`, `ensureConnected`, `leaveFeatureIntercepts`) but
`apps/cli/src/commands/intercept.ts` still owns the command body — 180 lines whose `fail()` ends
in `process.exit(1)`. In-process that would **take the claudeck server down**, so the command
needs the same treatment `workspace`/`init-workspace` got (throw a reported error, leave an argv
adapter) before the route can move.

**Also worth knowing when this is picked up:** the telepresence reads behind `getIntercepts()`
are `spawnSync`, so they block the caller's event loop — the whole express server, not just the
waiting request. They run under a 15s cap (`STATUS_READ` in `packages/sandbox-core/status.ts`)
for exactly that reason. Anything else moved in-process should be checked the same way.

---

## `getFormSchema()` Scans Your Home Directory for a Jira ID It Discards

**Severity:** Low (wasted work and a surprising `git` call, not a wrong result)
**Status:** Open
**Affects:** `packages/sandbox-core/sandbox.ts` — `getFormSchema()`, via `scrapeJiraId` in `workspace_prompts.ts`

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
