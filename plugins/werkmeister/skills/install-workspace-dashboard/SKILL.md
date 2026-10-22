---
name: install-workspace-dashboard
description: Install the Sandbox Workspaces live dashboard as a Cowork artifact. Use when the user asks to install, set up, or create the workspace dashboard, workspace list artifact, or sandbox control panel in Cowork. Requires a Cowork session with artifact support (mcp__cowork__create_artifact) and the Sandbox MCP server connected.
---

# Install the Sandbox Workspaces dashboard artifact

Installs `apps/sandbox-dashboard/dist/workspace-list.artifact.html` (from the
sandbox repo) as a persistent Cowork live artifact: an expandable
workspace list (container state, issue status, repos + PRs, lifecycle actions)
with an embedded Claude Code chat panel per workspace that continues that
workspace's newest session.

## Prerequisites — verify before installing

1. **Cowork artifacts available**: the `mcp__cowork__create_artifact` tool must
   exist in this session. If it doesn't, tell the user this pattern needs
   Cowork; the same UI is available inline as a fallback in Claude Desktop —
   calling the Sandbox `list-workspaces` tool renders it as an MCP App.
2. **Sandbox MCP server connected**: check that
   `mcp__plugin_werkmeister_werkmeister__list-workspaces` (or the equivalent under the
   user's server name) is available.
3. **Built HTML exists**: `apps/sandbox-dashboard/dist/workspace-list.artifact.html`
   in the sandbox checkout. If missing, build it:
   `cd apps/sandbox-dashboard && pnpm run build:ui` (needs `pnpm install` at the repo root
   first). This needs the sandbox repo cloned: the dashboard app is not part of
   the `werkmeister` npm package, so a machine with only the
   package installed cannot use this skill.

## Install steps

1. Read `apps/sandbox-dashboard/dist/workspace-list.artifact.html`. The MCP server
   name is baked in at build time from
   `apps/sandbox-dashboard/src/artifact-meta.json` (default `workspaces`),
   and the bundled script derives its tool-name prefix from the file's own
   `cowork-artifact-meta` block at runtime. If the session's Sandbox tools are
   named differently than the meta block says, change `serverName` in
   `src/artifact-meta.json` and rebuild (`pnpm run build:ui`) — do not hand-edit
   the HTML.
2. Write the HTML to a file in your scratch/outputs directory, e.g.
   `workspace-list.html`.
3. Call `mcp__cowork__create_artifact` with:
   - `id`: `workspace-list`
   - `html_path`: the file you just wrote
   - `mcp_tools`: the fully-qualified tool list from the file's
     `cowork-artifact-meta` block (all 19 `mcp__<server>__…` names)
4. Verify with `mcp__cowork__verify_artifact` (id `workspace-list`) — the debug
   log should show a `load` event and a successful `list-workspaces` call once
   the user opens it.

## After installing

1. **Keep a copy in the connected Cowork folder.** Also write the HTML to the
   root of the Cowork project's connected folder as
   `workspace-list.html`. This matters because re-opening the artifact in a
   later session uses `mcp__cowork__update_artifact`, which requires the source
   file to live inside that session's workspace (the connected folder or the
   session outputs dir). The canonical artifact lives under
   `~/Documents/Claude/Artifacts/`, which is *outside* the sandbox — so without
   an in-folder copy, Claude has to re-copy the ~27 KB HTML into the session on
   every open. A copy in the connected folder makes "load the dashboard" a
   one-step open with no per-session copy.

Tell the user:
- The artifact appears in Cowork's artifact panel and persists across sessions;
  it re-fetches live data each time it's opened (Reload button refreshes).
- Add a Cowork project instruction like "when I open a new chat session load the
  artifact workspace-list.html" so Claude surfaces it each session. Point it at
  the copy in the connected folder so the open needs no re-copy.
- The connected-folder copy is a snapshot. If the dashboard is rebuilt
  (`pnpm run build:ui`) or its server name changes, refresh the copy from
  `apps/sandbox-dashboard/dist/workspace-list.artifact.html` so it stays in sync.
- Chat sends run headless `claude -p` turns in the workspace directory with
  `--permission-mode acceptEdits`; tool activity streams into the panel while
  a turn runs, and "Resume Claude ⌨" opens the real interactive session in
  Terminal for long or permission-heavy work.

## Updating the dashboard

When the dashboard source changes — after a rebuild
(`cd apps/sandbox-dashboard && pnpm run build:ui`) or a server-name change — both
copies must be refreshed, or the user will keep seeing the old UI:

1. Read the rebuilt `apps/sandbox-dashboard/dist/workspace-list.artifact.html`
   (server-name changes go through `src/artifact-meta.json` + rebuild, never a
   hand-edit of the HTML).
2. Write it to your scratch/outputs dir and call `mcp__cowork__update_artifact`
   with `id: workspace-list` and that `html_path` to update the canonical
   artifact under `~/Documents/Claude/Artifacts/`.
3. **Also overwrite the connected-folder copy** (`workspace-list.html` at the
   root of the Cowork project folder) with the same HTML. This snapshot does not
   auto-update from the artifact, so if you skip it the next session's one-step
   open will load a stale dashboard.
4. Verify with `mcp__cowork__verify_artifact` (id `workspace-list`).
