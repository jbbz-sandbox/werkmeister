# Known Issues

Tracked concurrency and isolation issues in the sandbox.

---

## Sandbox Env Vars in `.zshrc` Are Invisible to Non-Interactive Shells

**Severity:** Moderate (breaks tooling, easy to misdiagnose)
**Status:** Open — install-time gap
**Affects:** Shell setup / installation (`SANDBOX_WORKSPACES_ROOT`, `SANDBOX_ROOT`)

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
**Status:** Open
**Affects:** `infra/config/services.yaml` environment blocks

Several service environment variables use `{service-name}` placeholders:

```yaml
REST_HELLO_URL: "http://{rest-hello}/api"
```

These are rendered verbatim into Docker Compose environment blocks. The literal curly braces are not valid hostnames and are not Docker Compose variable syntax (`${...}`). The intent is for these to resolve to Docker network aliases, but the braces need to be stripped.

**Workaround:** The programmatic compose generator (`apps/cli/src/lib/generate.ts`) builds its own `*_URL` environment variables using Docker DNS names (e.g., `http://next-hello:3000` for local services, `http://k8s-forwards:9053` for k8s services), bypassing these placeholders entirely. The `_resolve_service_refs()` function in `generate.ts` also resolves `{service-name}` placeholders in the nunjucks template path to Docker DNS aliases.

**Fix:** Either:
1. Strip braces at template render time and resolve to the Docker network alias (the service name)
2. Replace `{service-name}` with the correct Docker DNS alias (e.g., `k8s-forwards:9000`)

---

## k8s Port-Forward PID Tracking (Legacy Fallback)

**Severity:** Low
**Status:** Resolved

The legacy in-process fallback and bash script PID management are no longer used. k8s port-forwards now run inside a Docker container (`k8s-forwards`) managed by Docker Compose with built-in health checks and auto-restart, eliminating the PID tracking problem entirely.

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
**Affects:** `infra/proxy/ui/index.html`

The `X-Feature` cookie is set with `path=/`, meaning it applies to all tabs in the same browser. Users testing multiple features simultaneously need separate browser profiles or use the `X-Feature` HTTP header directly (e.g., via ModHeader browser extension).

**Easiest workaround:** `./sandbox open <feature>` launches an isolated incognito Chrome (its own throwaway profile) with the cookie already set and the window tagged `[feature]`, so each feature gets its own window with no cookie collision.

---

## Orphaned Per-Feature Volumes on Teardown

**Severity:** Low
**Status:** Resolved
**Affects:** `apps/cli/src/lib/docker.ts` — `compose_down()`

`sandbox down` preserves per-feature Docker volumes by default (for faster subsequent startups). Use `sandbox down --volumes` to remove them, or `sandbox clean` to bulk-remove orphaned volumes from stopped features.

---

## Caddy `handle` vs `route` Directive — Silent Route Dropping

**Severity:** Critical (causes blank pages / empty responses)
**Status:** Resolved — documented to prevent recurrence
**Affects:** `infra/proxy/Caddyfile`, `infra/templates/Caddyfile.j2`, `apps/cli/src/lib/generate.ts`

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
**Affects:** `infra/proxy/Caddyfile` (bind-mounted into `sandbox-caddy` container)

Docker Desktop's VirtioFS file sharing may not sync bind-mounted files immediately after writes on the host. The `infra/proxy/Caddyfile` file may show different sizes when compared between host and container, causing Caddy to use stale or truncated config.

**Symptoms:**
- `caddy adapt` reports `unexpected EOF` after editing Caddyfile
- `wc -l` shows different line counts on host vs inside container
- Caddy reload appears to succeed but config doesn't change

**Workaround:** Always use `docker cp` to push the file, then reload from the copied path:

```bash
docker cp infra/proxy/Caddyfile sandbox-caddy:/tmp/Caddyfile
docker exec sandbox-caddy caddy reload --config /tmp/Caddyfile
```

Do not rely on the bind mount at `/etc/caddy/Caddyfile` syncing in real-time for reloads.

---

## Workspace-Create Form Duplicated Across Desktop and Browser Surfaces

**Severity:** Low (deliberate; tech debt)
**Status:** Open — deferred optimization pass
**Affects:** `apps/sandbox-dashboard/src/mcp-app.ts` (Desktop MCP App), `apps/sandbox-dashboard/src/create-form.ts` (browser dashboard "New workspace" tab)

The RJSF workspace-create form is implemented twice — `WorkspaceForm`, `TextareaWidget`, `validateRepoSelection`, and `transformErrors` are duplicated (~120 lines, mostly identical) between the two surfaces. This is intentional for now: the browser dashboard is under active construction, and sharing would couple a churning surface to the shipping Desktop one, so an experiment on the browser form could regress Desktop.

The four genuine differences (why a naive share isn't free) are all host-level: transport (ext-apps `app.callServerTool` returning `CallToolResult` vs `bridge.callTool` throw-on-error), post-submit side effect (`updateModelContext` vs `onCreated`), styling (TR brand vs neutral list palette), and bootstrap (host pushes bundle via `ontoolresult` vs self-fetch in `initCreateForm`).

**Optimization pass (do after the browser dashboard stabilizes):**
1. `validateRepoSelection` and `transformErrors` are **byte-identical and host-agnostic** (pure, no `app`/`bridge`) — lift them into `lib/` and import in both. Zero regression risk; safe to do even before the browser surface settles.
2. Once the browser form stops moving, extract a shared `<WorkspaceForm callTool={…} />` component, threading the four host differences above as props/config, and have both entrypoints render it.
