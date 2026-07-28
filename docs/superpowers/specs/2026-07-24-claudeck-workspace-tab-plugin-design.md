# Claudeck Adoption — Phase 3: Project-scoped "Workspace" tab plugin

**Date:** 2026-07-24
**Status:** Design approved
**Scope:** A full-stack claudeck plugin that adds a project-scoped **Workspace** tab showing the *selected* feature workspace's inner repo worktrees and their git state. Reshapes the original Phase 3 ("sandbox management as a plugin") around the user's insight that this belongs in a project-scoped surface, not the global Repos tab.

---

## Background & goal

Phase 2 made feature workspaces selectable projects (chat roots at the workspace dir) and mirrored them in the global **Repos tab** (`repos.json`). The Repos tab is a *global* project manager — it shows all workspaces as siblings, which is inconsistent with the other tabs (Files, Git, Memory, Skills) that are **scoped to the selected project**.

The user's goal: a project-scoped view of **the selected feature workspace's repos/worktrees** and their git state. The core **Git tab** is project-scoped but single-cwd (operates only on `getCwd()`, i.e. the workspace's `sandbox-workspace` wrapper worktree) and isn't worktree-aware.

**Decision:** build a new project-scoped **plugin tab** (additive, no edits to vendored core), not extend the core Git tab. The Repos-tab (`repos.json`) sync stays for now; we revisit it once the new tab exists.

### Structure facts (verified)
- A feature workspace dir (e.g. `~/workspace/features/test-me`) is itself a worktree of the `sandbox-workspace` repo; its immediate subdirs that are git worktrees are the real repos (e.g. `sandbox` on branch `<user>/<feature>`).
- claudeck tab SDK (`/js/ui/tab-sdk.js`) `ctx`: `getProjectPath()`, `on('projectChanged', fn)`, `api`, `getSessionId()`, `getTheme()`, `storage`, `toast`, `showBadge`/`clearBadge`, `setTitle`.
- Full-stack plugins (`hasServer: true`) mount an express router at `/api/plugins/<id>` (as `plugins/repos` does).

---

## Design

### Decisions (approved)
- **Vehicle:** new project-scoped plugin tab (not a core Git-tab edit).
- **Data source:** self-contained in the plugin server — its own worktree discovery (`readdir` + `.git` check) and `git` exec (branch/status). No dependency on `sandbox-driver`; keeps the vendored app decoupled.

### Plugin: `sandbox-workspace`
Location: `apps/claudeck/plugins/sandbox-workspace/` — `manifest.json`, `server.js`, `client.js`, `client.css`.

- **manifest.json:** `{ id: "sandbox-workspace", name: "Workspace", icon: "🧩", hasServer: true, minClaudeckVersion: "1.4.0" }`.
- **server.js:** express router.
  - `GET /?project=<absPath>` →
    - Detect a sandbox workspace: `<project>/.sandbox/workspace.yml` exists. If not: `{ isWorkspace: false }`.
    - Else enumerate immediate subdirs that are git worktrees (have `.git`). For each: `{ repo, dir, branch, dirty, ahead, behind }` where `branch` = `git -C <dir> rev-parse --abbrev-ref HEAD`; `dirty` = count of `git -C <dir> status --porcelain` lines; `ahead`/`behind` = from `git -C <dir> status -sb` (best-effort, 0 when no upstream).
    - Return `{ isWorkspace: true, feature, workspacePath, repos: [...] }` (feature from `workspace.yml`).
  - Git/exec are best-effort: a repo that errors yields nulls, never a 500.
- **client.js:** `registerTab({ id: "sandbox-workspace", title: "Workspace", icon, lazy: true, init(ctx) })`.
  - On init and `ctx.on('projectChanged')`: `GET /api/plugins/sandbox-workspace?project=<ctx.getProjectPath()>`, render.
  - Render (safe DOM, no innerHTML interpolation of git data): each repo as a row — name, branch, clean/dirty (`● N` when dirty), `↑a ↓b` when nonzero. Empty/non-workspace states have their own messages.
  - Badge: total dirty count across repos via `ctx.showBadge` (clear when 0).
- **client.css:** minimal rows styled to match claudeck's dark terminal theme (reuse CSS variables where available).

### MVP scope
List worktrees + branch + dirty/ahead/behind for the selected workspace, reloading on project switch. **Deferred:** staging/commit (core Git tab covers per-cwd), PR links, docker/service status, actions (up/stop). Those are later increments on this same plugin.

---

## Acceptance criteria
- With a feature workspace selected (e.g. `test-me`), the **Workspace** tab lists its inner repo worktrees (e.g. `sandbox`) with the correct branch (`<user>/test-me`) and a clean/dirty indicator.
- Switching the selected project reloads the tab to that project's worktrees.
- Selecting a non-workspace project (e.g. `sandbox` itself) shows a clear "not a sandbox workspace" state, no error.
- No edits to vendored core files (only the new `plugins/sandbox-workspace/` dir); `VENDORED.md` notes the added plugin.
- Server route never 500s on a repo whose git call fails (best-effort nulls).

## Testing
The server's pure-ish parsing (porcelain/`-sb` → `{dirty, ahead, behind}`) is factored into a small pure function with an assert-based `node --test` (fixtures for clean, dirty, ahead/behind, no-upstream). Live verification via the running claudeck for the DOM/tab behavior.

## Risks & open items
- **Untrusted git output → XSS:** render via `textContent`/DOM, never `innerHTML` string interpolation (same rule as the earlier dashboard work).
- **Plugin discovery:** confirm apps/claudeck plugins in `plugins/` are auto-loaded (repos/claude-editor are); if claudeck only scans `~/.claudeck/plugins`, symlink or document install.
- **project param trust:** the server execs `git -C <dir>` under the given project path; restrict to reading git state (no arbitrary shell), and treat `project` as a path only.

## Out of scope (Phase 3 MVP)
- Staging/commit/push UI (core Git tab; possible later).
- PR status, docker/service status, lifecycle actions (up/stop) — later increments.
- Removing/replacing the Repos-tab `repos.json` sync (revisit after this ships).
