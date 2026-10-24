# werkmeister-ui

## 0.5.6

### Patch Changes

- Updated dependencies [2f92c5f]
- Updated dependencies [d26e6ae]
  - werkmeister-core@0.34.0

## 0.5.5

### Patch Changes

- werkmeister-core@0.33.2

## 0.5.4

### Patch Changes

- werkmeister-core@0.33.1

## 0.5.3

### Patch Changes

- werkmeister-core@0.33.0

## 0.5.2

### Patch Changes

- werkmeister-core@0.32.0

## 0.5.1

### Patch Changes

- werkmeister-core@0.31.0

## 0.5.0

### Minor Changes

- 0c00bdd: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

### Patch Changes

- Updated dependencies [0c00bdd]
  - werkmeister-core@0.30.0

## 0.4.7

### Patch Changes

- werkmeister-core@0.29.0

## 0.4.6

### Patch Changes

- Updated dependencies [fecad45]
  - werkmeister-core@0.28.1

## 0.4.5

### Patch Changes

- werkmeister-core@0.28.0

## 0.4.4

### Patch Changes

- werkmeister-core@0.27.0

## 0.4.3

### Patch Changes

- werkmeister-core@0.26.1

## 0.4.2

### Patch Changes

- Updated dependencies [0735db5]
  - werkmeister-core@0.26.0

## 0.4.1

### Patch Changes

- Updated dependencies [92f3b4a]
  - werkmeister-core@0.25.0

## 0.4.0

### Minor Changes

- 6c99717: SW-57: the rest of the UI is React. The chat panel, the options input, the usage breakdown, the create form's card and the dashboard's tab shell, Open Pull Requests, Health and Links tabs no longer use the vanilla-DOM `el()` / `injectCss()` helpers, which are gone. Each component renders its own stylesheet with `Css` (a React-hoisted `<style>`, one per component); the tokens stay CSS custom properties in `tokens.css`. `werkmeister-ui` now exports `ChatPanel`, `OptionsInput`, `Usage`, `CreateForm` and `WorkspaceList` in place of `initChatPanel`, `createOptionsInput` and `renderUsage`; `initWorkspaceUI` and `initCreateForm` keep their signatures. The workspace card takes `renderPanel(kind)` instead of `mountPanel(kind, host)`. On the Desktop-inline and Cowork surfaces an open chat now syncs the transcript every 3 s while a turn runs, as its polling was meant to, instead of only when the turn ends.

### Patch Changes

- werkmeister-core@0.24.1

## 0.3.0

### Minor Changes

- 3fc5287: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.
- 5886cc5: SW-54: the dashboard and MCP App workspace card gains `↗ Continue in Desktop` and `＋ New session`, the top bar gains `＋ New workspace` (the MCP App list opens the create form in place), and the list gains a `☐ Focused only` filter. `claude-resume` takes `new: true` to open a fresh Terminal session.

### Patch Changes

- Updated dependencies [3fc5287]
- Updated dependencies [3c1a49a]
- Updated dependencies [5886cc5]
- Updated dependencies [20f67e7]
  - werkmeister-core@0.24.0

## 0.2.0

### Minor Changes

- 050e037: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

### Patch Changes

- Updated dependencies [050e037]
  - werkmeister-core@0.23.0

## 0.1.1

### Patch Changes

- Updated dependencies [58a61bd]
- Updated dependencies [3fdbf6d]
  - werkmeister-core@0.22.0
