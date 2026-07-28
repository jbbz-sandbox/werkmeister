# Claudeck Adoption — Phase 2: Feature Workspaces as Projects

**Date:** 2026-07-24
**Status:** Design approved; spec written
**Scope:** Phase 2 of the claudeck adoption. Makes each sandbox feature workspace appear as a claudeck "project" so chat opens rooted at the workspace's root. Depends on Phase 1 (vendored claudeck running).

> **Superseded in part (2026-07-24):** the `repos.json` (Repos-tab) half of the sync was **removed** after it shipped — the Repos tab is a *global* project manager, not project-scoped, so auto-populating it with feature-workspace groups was confusing. The sync now writes **only `folders.json`** (the chat picker). The per-workspace repo/worktree view lives in the project-scoped **Workspace** tab plugin instead (see the Phase 3 spec). `scripts/lib/merge-workspaces.mjs` and the driver's `listRepoWorktrees` export were removed accordingly. The `repos.json`/`mergeWorkspaces` sections below are retained as historical design context only.

---

## Background & goal

Phase 1 vendored upstream claudeck and proved that adding a directory to `~/.claudeck/config/repos.json` makes it a selectable project whose chat is rooted at that directory. Phase 2 automates that: generate the workspace entries from the sandbox CLI's own view of workspaces, so the user never hand-edits `repos.json`.

**Single source of truth:** the workspace list comes from `sandbox-driver`'s `listWorkspaces()` (which shells out to the `sandbox` CLI), consistent with the project-wide principle that the CLI owns workspace truth.

### Integration facts (verified against the vendored code)

**Correction (2026-07-24):** the initial spec assumed `repos.json` drove the chat's project selector. It does not. There are **two** config files, and we write **both**:

- **`folders.json`** — the flat project list the **chat project picker** reads via the core `GET /api/projects` route (`server/routes/projects.js`). Schema: `[{ "name": "...", "path": "..." }]` (a `source` marker and optional `systemPrompt` are tolerated). **This is the file that makes a workspace selectable for chat** (the phase goal).
- **`repos.json`** — read/written by the `repos` **tab** plugin (`plugins/repos/server.js`) for its grouped tree view (`GET /api/plugins/repos`); re-read per request. Schema:
  ```json
  {
    "groups": [{ "id": "...", "name": "...", "parentId": null }],
    "repos":  [{ "id": "...", "name": "...", "path": "...", "groupId": null, "url": null }]
  }
  ```
- Both live under `(CLAUDECK_HOME || ~/.claudeck)/config/`. Both are re-read on request, so a UI refresh suffices — no server restart.
- `listWorkspaces()` returns `{ root, workspaces: [{ name, path, vscodeUri, jiraId, jiraUrl, labels }] }`.

---

## Design

### Decisions (approved)
- **Mechanism:** a standalone Node script, run on demand via an npm script. Not a CLI subcommand and not the Phase 3 plugin.
- **Trigger:** on-demand only (no auto-hooks into the sandbox lifecycle this phase).

### Components
- **Create:** `scripts/sync-workspaces-to-claudeck.mjs` — the sync entry point; writes **both** `folders.json` and `repos.json`.
- **Create:** `scripts/lib/merge-folders.mjs` — pure `mergeFolders(existing, workspaces)` → flat `folders.json` array (managed entries marked `source: "sandbox"`). The file the chat picker uses.
- **Create:** `scripts/lib/merge-workspaces.mjs` — pure `mergeWorkspaces(existing, workspaces)` → grouped `repos.json` (managed repos id-prefixed `r_ws_`, under the "Feature Workspaces" group). The Repos-tab tree.
- **Modify:** root `package.json` — add script `"claudeck:sync": "node scripts/sync-workspaces-to-claudeck.mjs"`.
- **Create:** `scripts/lib/merge-folders.test.mjs`, `scripts/lib/merge-workspaces.test.mjs` — assert-based unit tests for each pure merge.

### Structure
Split IO from logic so the merge is unit-testable:
- **Pure:** `mergeWorkspaces(existing, workspaces)` → new `repos.json` object. No IO. This is the tested unit.
- **IO wrapper (`main`)**: resolve config path (`CLAUDECK_HOME || ~/.claudeck`), read existing `repos.json` (default `{groups:[],repos:[]}` if absent), call `listWorkspaces()`, call `mergeWorkspaces`, write back as 2-space JSON + trailing newline (matching the plugin's `writeData` format), print a summary.

### Managed-entry convention (idempotent, non-destructive)

**Correction (2026-07-24):** the Repos tab mirrors the *worktree nesting*, not the workspaces as flat entries. A feature workspace dir (e.g. `~/workspace/features/test-me`) is itself a worktree of the `sandbox-workspace` repo; inside it are the actual repo worktrees (e.g. `sandbox` on branch `<user>/<feature>`). So:

- **One managed group per feature**, named after the feature: `{ id: "g_ws_<feature>", name: "<feature>", parentId: null }`.
- **One managed repo per inner worktree** of that workspace (the immediate subdirs that are git worktrees, via the driver's `listRepoWorktrees`): `{ id: "r_ws_<feature>_<repo>", name: "<repo>", path: "<workspacePath>/<repo>", groupId: "g_ws_<feature>", url: null }`. (Decision: inner repos only — the `sandbox-workspace` wrapper root is not listed.)
- **Managed markers:** the `g_ws_` group-id prefix and the `r_ws_` repo-id prefix. Merge = drop all `g_ws_`/`r_ws_`-prefixed entries, keep everything else untouched, then append the freshly computed groups/repos. Adds new features, updates paths, prunes removed features — never touches manual entries.
- **Dedupe guard:** if a non-managed repo already holds an inner-repo `path` (object `.path` or bare-string entry), skip the managed entry for that path; the group is still created.

Input shape: `mergeWorkspaces(existing, workspaces)` where `workspaces = [{ name, path, repos: [{ repo, dir }] }]` — the sync attaches each workspace's `repos` via `listRepoWorktrees(ws.path)` (newly exported from `sandbox-driver`).

### No restart needed
After `npm run claudeck:sync`, refresh the claudeck UI — the `repos` plugin reads `repos.json` fresh on the next `GET /`.

---

## Acceptance criteria
- `npm run claudeck:sync` writes **`folders.json`** (flat, each workspace a project, `source: "sandbox"`) and **`repos.json`** (one `g_ws_<feature>` group per workspace, each containing its inner repo worktrees as `r_ws_<feature>_<repo>` entries with the correct nested absolute `path`).
- In the claudeck UI: the workspace appears in the **chat project picker** and selecting it roots chat at its path (`pwd` check); the **Repos tab** shows `<feature> ▸ <repo>` (e.g. `test-me ▸ sandbox`).
- Manual entries present before the run are preserved.
- Idempotent: a second run produces no change (both files).
- Pruning: deleting a workspace and re-running removes its `g_ws_`/`r_ws_` group+repos and its managed `folders.json` entry.
- Unit tests for `mergeWorkspaces` and `mergeFolders` pass (add + prune + manual-preservation + dedupe + idempotence).

## Testing
Two runnable checks (`node --test`, no framework): `scripts/lib/merge-workspaces.test.mjs` and `scripts/lib/merge-folders.test.mjs`, each exercising its pure merge with fixtures containing a manual entry and a stale managed entry, asserting managed entries added, stale pruned, manual preserved, dedupe honored, and `merge(merge(x)) === merge(x)`.

## Risks & open items
- **Requires `sandbox-driver` built** (`packages/sandbox-driver/dist`) so the script can import `listWorkspaces`. Document `npm run build` (or building the driver) as a prerequisite.
- **`isGitRepo` bypass:** direct file writes skip the `repos` plugin's git-repo validation. Feature workspaces are git worktrees (have `.git`), so this is fine in practice; a non-git workspace path would still be written.
- **Concurrent writes:** if the user edits repos via the UI while the sync runs, last-writer-wins. On-demand triggering keeps this rare.
- **Name uniqueness:** `r_ws_<name>` assumes unique workspace names (guaranteed by the sandbox CLI). Note in code.

## Out of scope (Phase 2)
- Auto-hooking the sync into `sandbox workspace` create/remove (deferred; on-demand chosen).
- The Phase 3 sandbox-management claudeck plugin (create/status/PRs UI).
- Listing the `sandbox-workspace` wrapper root as a repo (decided: inner repos only); deeper nesting or per-workspace claudeck settings.
