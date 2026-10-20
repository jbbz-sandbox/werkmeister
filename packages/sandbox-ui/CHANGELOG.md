# werkmeister-ui

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
