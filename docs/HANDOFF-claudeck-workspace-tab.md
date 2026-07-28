# Handoff — Claudeck "Workspace" tab: next features

**Date:** 2026-07-24
**Branch:** `claudeck`
**Audience:** an engineer (or agent) continuing this work with no prior context.

This note hands off three planned additions to the **Workspace** tab plugin:
1. **PR status** per repo worktree
2. **Docker service status** for the workspace
3. **Lifecycle actions** (up / stop / restart / down)

Everything you need to continue is below.

---

## 1. What exists today

We vendored the upstream **claudeck** app into `apps/claudeck/` (a browser UI for Claude Code; see `apps/claudeck/VENDORED.md` for provenance) and added a **built-in full-stack plugin** that gives a project-scoped view of the selected sandbox feature workspace.

**Plugin:** `apps/claudeck/plugins/sandbox-workspace/`
- `manifest.json` — `{ id: "sandbox-workspace", name: "Workspace", hasServer: true, minClaudeckVersion: "1.4.0" }`
- `server.js` — express router auto-mounted at `/api/plugins/sandbox-workspace/`. `GET /?project=<absPath>`:
  - `{ isWorkspace: false }` if `<project>/.sandbox/workspace.yml` is absent.
  - else `{ isWorkspace: true, feature, workspacePath, repos: [{ repo, dir, branch, upstream, dirty, ahead, behind }] }` — enumerates immediate subdirs that are git worktrees and runs `git status --porcelain=v1 -b` in each. **Self-contained** (readdir + `git`), no dependency on our other packages.
- `client.js` — `registerTab({ id, title: "Workspace", init(ctx) })`. Project-scoped: reads `ctx.getProjectPath()`, reloads on `ctx.on("projectChanged", …)`. Renders one collapsible **card per worktree**; expanding a card builds a full git panel scoped to that worktree's `dir` using claudeck's `execCommand(cmd, dir)` (from `/js/core/api.js`): branch switch, status (stage/unstage/discard), inline file diff, commit, and log.
- `client.css` — styles scoped to `.sandbox-workspace-tab`, using claudeck theme vars.
- `parse-git.mjs` / `parse-status.mjs` (+ `.test.mjs`) — **pure** parsers with `node --test` unit tests. Keep this pattern: put parsing in a pure module, unit-test it, and keep DOM/IO in `client.js`/`server.js`.

**Why the Workspace tab exists:** the core **Git tab** (`apps/claudeck/public/js/panels/git-panel.js`) operates only on `getCwd()` = the selected project = the *top-level* `sandbox-workspace` worktree. It ignores the nested repo worktrees (e.g. `sandbox`). The Workspace tab surfaces those nested worktrees with full git capability.

**Note:** the earlier `repos.json` sync (Repos-tab groups) was **removed** — the Repos tab is a global manager, not project-scoped. The only sync left is `scripts/sync-workspaces-to-claudeck.mjs` → writes `folders.json` (the chat project picker). Don't resurrect the repos.json path.

### How to run / verify
```bash
cd apps/claudeck && node cli.js --port 9009 --no-auth   # http://localhost:9009
```
In the browser: dismiss the welcome, pick a project (e.g. `test-me`), open the right panel (⌘B), enable the tab once via **Plugin Marketplace → Installed → check "Sandbox Workspace" → Apply**, then open the **Workspace** tab. `client.js`/`client.css` are static-served — a browser reload picks up client changes; `server.js` changes need a claudeck restart.

Run tests: `node --test apps/claudeck/plugins/sandbox-workspace/*.test.mjs`

---

## 2. Architecture patterns to follow

- **Add server data** via the existing route (`server.js`): extend the `GET /?project=` response, or add sibling routes (`router.get("/prs", …)`). The whole plugin dir is static-served, so `client.js` can `import` sibling `.mjs` modules (e.g. `./parse-status.mjs`).
- **Client** talks to its server at `/api/plugins/sandbox-workspace/…`, and/or uses `execCommand(cmd, dir)` for per-worktree shell commands (same primitive the git panel uses; returns `{ stdout, stderr, error }`).
- **Security (non-negotiable):** all git/gh/docker output is untrusted → build DOM with `textContent`/`createElement`, **never** `innerHTML` string interpolation. Keep claudeck loopback-only (it execs privileged commands). When interpolating a path/arg into a shell command, quote it (see the `q()` helper in `client.js`).
- **Best-effort:** a failing `gh`/`docker`/`git` call should degrade to a null/empty state, never a 500 or a thrown client error.

### Self-contained vs. reuse `sandbox-driver`
The plugin is currently **self-contained** (no `sandbox-driver` dep), which keeps the vendored app decoupled. For the features below you can stay self-contained (exec `gh`/`docker`/`sandbox` directly in the server route) **or** add `sandbox-driver` as a dependency of `apps/claudeck` and reuse its functions (DRY, but couples the vendored app and edits its `package.json`). Recommended: **self-contained for PR + docker** (simple exec, mirrors the git panel); consider the **driver for lifecycle** (its `runWorkspaceAction` already handles sandbox-bin resolution and the cwd/.env nuance). The relevant driver functions (in `packages/sandbox-driver/sandbox.ts`) if you go that route:
- `getWorkspacePRs(): Promise<WorkspacePrs[]>` — `WorkspacePrs = { name, repos: RepoPr[] }`, `RepoPr = { repo, branch, url, state: "OPEN"|"MERGED"|"CLOSED"|null, title, labels: string[] }`. Returns **all** workspaces (filter by the selected one's `name`).
- `getWorkspaceStatuses(): Promise<{ statuses: WorkspaceStatus[]; infra }>` — `WorkspaceStatus = { name, state: "up"|"partial"|"stopped"|"down"|"unknown", running, total, slot, ports, services: [{ name, state: ServiceHealth }], claude }`, `ServiceHealth = "healthy"|"starting"|"unhealthy"|"running"|"down"`. Returns **all** workspaces.
- `runWorkspaceAction(name, action): Promise<{ command, output, path }>`, `WORKSPACE_ACTIONS = ["up","stop","restart","down"]`. Runs the `sandbox` CLI with cwd = the workspace dir (so it resolves feature/slot from that workspace's `.env`).

---

## 3. Feature: PR status per worktree

**Goal:** for each repo worktree in the Workspace tab, show its branch's PR — state (OPEN/MERGED/CLOSED) and a clickable link — next to the branch/status you already render.

**Data (self-contained, recommended):** in `server.js`, per worktree run `gh` in the worktree dir:
```
gh pr view --json state,url,title,number,labels   # current branch's PR, or nonzero if none
# fallback: gh pr list --head <branch> --json state,url,title,number,state --limit 1
```
Parse the JSON into `{ state, url, title } | null`. Add it to each `repos[]` entry in the `GET /?project=` response (e.g. `pr: { state, url, title } | null`). Factor the JSON→shape mapping into a pure `parse-pr.mjs` with a `node --test`.

**UI (`client.js`):** in the collapsed card header and/or panel, render a small PR pill: `OPEN`/`MERGED`/`CLOSED` colored, linking to `pr.url` (open in new tab, `rel="noopener noreferrer"`, and **scheme-check** `^https?://` before using as href — same rule used elsewhere). Badge idea: count of open PRs across worktrees via `ctx.showBadge`.

**Gotchas:** `gh` may be unauthenticated or absent (best-effort → `pr: null`); network latency (do these in parallel with `Promise.all`, add a timeout like the git calls' `timeout: 5000`); a branch may have no PR (nonzero exit — treat as null, not error).

---

## 4. Feature: Docker service status

**Goal:** show the workspace's service containers and health (the workspace has a `docker-compose.yml`; `.sandbox/workspace.yml` lists `services:`).

**Data (self-contained, recommended):** in `server.js`, add a route or extend the response with a `docker compose ps` run in the **workspace root** (not a worktree):
```
docker compose ps --format json    # one JSON object per line (compose v2)
```
Parse each line → `{ service, state, health, ports }`. Factor parsing into `parse-compose.mjs` + test. (Alternatively reuse the driver's `getWorkspaceStatuses()` and filter to the selected workspace's `name` — richer, includes slot/ports/per-service `ServiceHealth`, but couples to the driver.)

**UI:** a "Services" section in the panel: each service with a health dot (healthy/starting/unhealthy/running/down) and port. Consider a top-level workspace state pill (up/partial/down) in the tab header.

**Gotchas:** docker daemon may be down (best-effort → empty/"docker unavailable"); `docker compose ps --format json` output shape differs across compose versions (guard parsing); this is per-**workspace**, so run it once at the workspace root, not per worktree.

---

## 5. Feature: Lifecycle actions (up / stop / restart / down)

**Goal:** buttons in the Workspace tab to run `sandbox up|stop|restart|down` for the selected workspace, with running-state feedback.

**Action (two options):**
- **Driver (recommended for correctness):** add `sandbox-driver` dep to `apps/claudeck`, add a `POST /action` route that calls `runWorkspaceAction(workspaceName, action)` (validates against `WORKSPACE_ACTIONS`, runs the CLI with cwd = workspace dir so `.env` resolves feature/slot). You'll need the workspace **name**; derive it from `feature` (already in the route response) or the dir basename.
- **Self-contained:** resolve the `sandbox` binary (`process.env.SANDBOX_BIN` → `~/.local/bin/sandbox`) and `execFile(sandboxBin, [action], { cwd: workspacePath })`. Mirrors the driver's own resolution (`packages/sandbox-driver/sandbox.ts` `resolveSandboxBin`), but you must replicate the cwd/.env behavior.

**UI:** an action row (Up / Stop / Restart / Down). Disable buttons while an action runs (these are long-running); stream or poll output; **confirm** destructive actions (down/stop). Refresh the docker-service section (feature 4) after an action completes. Reflect the workspace `state` pill.

**Gotchas:** actions are slow (compose up can take minutes — don't block the UI; consider a timeout + a "running…" state, or stream via the existing WebSocket `ctx.on("ws:message")` if you wire server events); `down` is destructive (confirm); the CLI must run with cwd = the workspace dir.

---

## 6. Definition of done / verification checklist
- [ ] New parsing logic (`parse-pr.mjs`, `parse-compose.mjs`) has passing `node --test` unit tests.
- [ ] `server.js` routes are best-effort (no 500 when `gh`/`docker`/`sandbox` fail or are absent).
- [ ] Client renders via `textContent`/DOM (no `innerHTML` of untrusted data); PR links are scheme-checked.
- [ ] Verified live: select `test-me`, open the Workspace tab — PR pills, service health, and lifecycle buttons behave; a non-workspace project still shows "Not a sandbox feature workspace."
- [ ] `VENDORED.md` "Local modifications" updated if you add a `sandbox-driver` dep or new routes.
- [ ] No edits to vendored core files (`apps/claudeck/public/**`, `server.js`, etc.) — keep additions inside `plugins/sandbox-workspace/`.

## 7. Key references
- Plugin: `apps/claudeck/plugins/sandbox-workspace/{manifest.json,server.js,client.js,client.css,parse-git.mjs,parse-status.mjs}`
- Tab SDK + `ctx` API: `apps/claudeck/public/js/ui/tab-sdk.js`
- `execCommand`: `apps/claudeck/public/js/core/api.js` (returns `{ stdout, stderr, error }`)
- Core Git panel (reference for git UX): `apps/claudeck/public/js/panels/git-panel.js`
- Driver (optional reuse): `packages/sandbox-driver/sandbox.ts` — `getWorkspacePRs`, `getWorkspaceStatuses`, `runWorkspaceAction`, `WORKSPACE_ACTIONS`
- Specs: `docs/superpowers/specs/2026-07-24-claudeck-workspace-tab-plugin-design.md` (Phase 3), `…-workspaces-as-projects-design.md` (Phase 2)
