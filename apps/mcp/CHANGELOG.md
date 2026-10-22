# sandbox-mcp

## 0.4.6

### Patch Changes

- werkmeister-core@0.28.0
- werkmeister-ui@0.4.5

## 0.4.5

### Patch Changes

- werkmeister-core@0.27.0
- werkmeister-ui@0.4.4

## 0.4.4

### Patch Changes

- werkmeister-core@0.26.1
- werkmeister-ui@0.4.3

## 0.4.3

### Patch Changes

- Updated dependencies [0735db5]
  - werkmeister-core@0.26.0
  - werkmeister-ui@0.4.2

## 0.4.2

### Patch Changes

- Updated dependencies [92f3b4a]
  - werkmeister-core@0.25.0
  - werkmeister-ui@0.4.1

## 0.4.1

### Patch Changes

- 6c99717: SW-57: the rest of the UI is React. The chat panel, the options input, the usage breakdown, the create form's card and the dashboard's tab shell, Open Pull Requests, Health and Links tabs no longer use the vanilla-DOM `el()` / `injectCss()` helpers, which are gone. Each component renders its own stylesheet with `Css` (a React-hoisted `<style>`, one per component); the tokens stay CSS custom properties in `tokens.css`. `werkmeister-ui` now exports `ChatPanel`, `OptionsInput`, `Usage`, `CreateForm` and `WorkspaceList` in place of `initChatPanel`, `createOptionsInput` and `renderUsage`; `initWorkspaceUI` and `initCreateForm` keep their signatures. The workspace card takes `renderPanel(kind)` instead of `mountPanel(kind, host)`. On the Desktop-inline and Cowork surfaces an open chat now syncs the transcript every 3 s while a turn runs, as its polling was meant to, instead of only when the turn ends.
- Updated dependencies [6c99717]
  - werkmeister-ui@0.4.0
  - werkmeister-core@0.24.1

## 0.4.0

### Minor Changes

- 5886cc5: SW-54: the dashboard and MCP App workspace card gains `↗ Continue in Desktop` and `＋ New session`, the top bar gains `＋ New workspace` (the MCP App list opens the create form in place), and the list gains a `☐ Focused only` filter. `claude-resume` takes `new: true` to open a fresh Terminal session.

### Patch Changes

- Updated dependencies [3fc5287]
- Updated dependencies [3c1a49a]
- Updated dependencies [5886cc5]
- Updated dependencies [20f67e7]
  - werkmeister-core@0.24.0
  - werkmeister-ui@0.3.0

## 0.3.9

### Patch Changes

- 050e037: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

- Updated dependencies [050e037]
  - werkmeister-core@0.23.0
  - werkmeister-ui@0.2.0

## 0.3.8

### Patch Changes

- e5a3eb9: apps/mcp now builds the MCP App pages (`mcp-app.html`, `mcp-list.html`) itself, from the new `werkmeister-ui` package (`packages/sandbox-ui`), and serves them from its own `dist/`. The dashboard and apps/mcp share one copy of the UI modules, and `werkmeister-ui` adds the non-DOM display model the card, pane and VS Code will read.
- Updated dependencies [58a61bd]
- Updated dependencies [3fdbf6d]
  - werkmeister-core@0.22.0
  - werkmeister-ui@0.1.1

## 0.3.7

### Patch Changes

- Updated dependencies [084b453]
- Updated dependencies [e4adda8]
  - werkmeister-core@0.21.0

## 0.3.6

### Patch Changes

- Updated dependencies [afc375a]
  - werkmeister-core@0.20.0

## 0.3.5

### Patch Changes

- Updated dependencies [0ec96f9]
  - werkmeister-core@0.19.0

## 0.3.4

### Patch Changes

- Updated dependencies [963da69]
- Updated dependencies [28e39b6]
- Updated dependencies [cfea47d]
- Updated dependencies [8a0c8b4]
  - werkmeister-core@0.18.0

## 0.3.3

### Patch Changes

- Updated dependencies [8c2a1eb]
  - werkmeister-core@0.17.0

## 0.3.2

### Patch Changes

- Updated dependencies [7035cff]
- Updated dependencies [183a2e9]
- Updated dependencies [7d121e8]
- Updated dependencies [4e08dd6]
- Updated dependencies [fe14381]
- Updated dependencies [88fb0e3]
- Updated dependencies [4240fba]
  - werkmeister-core@0.16.0

## 0.3.1

### Patch Changes

- Updated dependencies [dba74e3]
  - werkmeister-core@0.15.0

## 0.3.0

### Minor Changes

- 5e11f2a: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- Updated dependencies [ccdb6a0]
- Updated dependencies [192c2f2]
- Updated dependencies [cc2806e]
- Updated dependencies [5e11f2a]
  - sandbox-core@0.14.0

## 0.2.3

### Patch Changes

- Updated dependencies [d5b1a9a]
  - sandbox-core@0.13.0

## 0.2.2

### Patch Changes

- Updated dependencies [aba829c]
  - sandbox-core@0.12.0

## 0.2.1

### Patch Changes

- 2f106fc: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).
- Updated dependencies [2f106fc]
  - sandbox-core@0.11.0

## 0.2.0

### Minor Changes

- afd99d4: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

### Patch Changes

- Updated dependencies [afd99d4]
- Updated dependencies [63fdd7b]
- Updated dependencies [a671c9f]
  - sandbox-core@0.10.0

## 0.1.8

### Patch Changes

- Updated dependencies [09c0746]
- Updated dependencies [5d20904]
- Updated dependencies [69a386d]
  - sandbox-core@0.9.0

## 0.1.7

### Patch Changes

- Updated dependencies [594efe1]
- Updated dependencies [542eecf]
  - sandbox-core@0.8.0

## 0.1.6

### Patch Changes

- Updated dependencies [1f9039f]
  - sandbox-core@0.7.0

## 0.1.5

### Patch Changes

- Updated dependencies [2d701e4]
  - sandbox-core@0.6.0

## 0.1.4

### Patch Changes

- sandbox-core@0.5.0

## 0.1.3

### Patch Changes

- Updated dependencies [6f38fc7]
- Updated dependencies [6d2333e]
- Updated dependencies [4ff0cc7]
- Updated dependencies [9a89e99]
  - sandbox-core@0.4.0

## 0.1.2

### Patch Changes

- sandbox-core@0.3.0

## 0.1.1

### Patch Changes

- sandbox-core@0.2.0
