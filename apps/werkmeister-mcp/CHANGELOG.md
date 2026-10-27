# sandbox-mcp

## 0.7.0

### Minor Changes

- 75bdd3d: SW-108: a post-mortem comes before close-out. `close-out` (CLI, MCP, pane, VS Code) refuses while the workspace has no `postmortem.md`, unless `--skip-postmortem "<reason>"` (MCP `skip_postmortem`) gives a reason, which goes in `closeout.md`. The new werkmeister `postmortem` skill gathers the run's problems, agrees a change for each with the person, writes `postmortem.md` and turns each change into an SW issue, standards edit or memory entry. The ICM route table, propose and spike checks, `pr-rules.md` (ICM and JIT) and `w9r-pr` send agents there before close-out, and the handoff commits `postmortem.md` to the record branch.

### Patch Changes

- Updated dependencies [3bd6bf5]
- Updated dependencies [75bdd3d]
  - werkmeister-core@0.43.0
  - werkmeister-ui@0.5.24

## 0.6.21

### Patch Changes

- Updated dependencies [ba48455]
  - werkmeister-core@0.42.0
  - werkmeister-ui@0.5.23

## 0.6.20

### Patch Changes

- Updated dependencies [810e41b]
- Updated dependencies [2290eeb]
  - werkmeister-core@0.41.0
  - werkmeister-ui@0.5.22

## 0.6.19

### Patch Changes

- Updated dependencies [4fc26a8]
  - werkmeister-core@0.40.0
  - werkmeister-ui@0.5.21

## 0.6.18

### Patch Changes

- Updated dependencies [c0d2c42]
  - werkmeister-core@0.39.0
  - werkmeister-ui@0.5.20

## 0.6.17

### Patch Changes

- werkmeister-core@0.38.1
- werkmeister-ui@0.5.19

## 0.6.16

### Patch Changes

- werkmeister-core@0.38.0
- werkmeister-ui@0.5.18

## 0.6.15

### Patch Changes

- Updated dependencies [5b37069]
  - werkmeister-core@0.37.1
  - werkmeister-ui@0.5.17

## 0.6.14

### Patch Changes

- Updated dependencies [fa98c10]
  - werkmeister-core@0.37.0
  - werkmeister-ui@0.5.16

## 0.6.13

### Patch Changes

- werkmeister-core@0.36.2
- werkmeister-ui@0.5.15

## 0.6.12

### Patch Changes

- Updated dependencies [67637e6]
  - werkmeister-core@0.36.1
  - werkmeister-ui@0.5.14

## 0.6.11

### Patch Changes

- 9dfc1cc: SW-92: `werkmeister migrate` moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml` values, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch launchd agent (or crontab line) and each workspace's compose file. It refuses while a container that mounts the old home, or any workspace container, is running. A second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`, and `--check` reports without writing. Registry sync, `detect` and the pre-PR gate now read `<repo>/.werkmeister/services.yaml` first and fall back to `<repo>/.sandbox/services.yaml`. `detect` writes new fragments under `.werkmeister/`. Fragments can use `{{werkmeister_home}}` for the tool's home folder. This repo's fragment moved to `.werkmeister/services.yaml` and uses it, so **pull and rebuild the CLI before the next `registry sync`**: an older build skips the moved fragment. Docs, help text and generated text now say `~/.werkmeister`, with `~/.sandbox` named only as the legacy name.
- Updated dependencies [7fa838e]
- Updated dependencies [9dfc1cc]
  - werkmeister-core@0.36.0
  - werkmeister-ui@0.5.13

## 0.6.10

### Patch Changes

- werkmeister-core@0.35.5
- werkmeister-ui@0.5.12

## 0.6.9

### Patch Changes

- Updated dependencies [8dd972e]
  - werkmeister-core@0.35.4
  - werkmeister-ui@0.5.11

## 0.6.8

### Patch Changes

- Updated dependencies [e3c5ec9]
  - werkmeister-core@0.35.3
  - werkmeister-ui@0.5.10

## 0.6.7

### Patch Changes

- werkmeister-core@0.35.2
- werkmeister-ui@0.5.9

## 0.6.6

### Patch Changes

- Updated dependencies [6d24ff6]
  - werkmeister-core@0.35.1
  - werkmeister-ui@0.5.8

## 0.6.5

### Patch Changes

- Updated dependencies [8666887]
  - werkmeister-core@0.35.0
  - werkmeister-ui@0.5.7

## 0.6.4

### Patch Changes

- Updated dependencies [8c99ce9]
- Updated dependencies [157e9e8]
  - werkmeister-core@0.34.0
  - werkmeister-ui@0.5.6

## 0.6.3

### Patch Changes

- 2922867: `werkmeister status`, the Workspaces pane and the dashboard show a stopped k8s-forwards container as neutral ("stopped — not needed by any running workspace") when no running workspace has a cluster-backed local service. Since SW-42 `up` starts the forwarder only for such workspaces, so on a werkmeister-only machine it is stopped by design. While a running workspace needs it, a stopped forwarder still shows red with the `docker restart sandbox-k8s-forwards` hint. `k8s-forwards-status` gains a `stopped` flag, and the infra tally leaves out a forwarder nothing needs, so infra no longer reads partial.
  - werkmeister-core@0.33.2
  - werkmeister-ui@0.5.5

## 0.6.2

### Patch Changes

- werkmeister-core@0.33.1
- werkmeister-ui@0.5.4

## 0.6.1

### Patch Changes

- werkmeister-core@0.33.0
- werkmeister-ui@0.5.3

## 0.6.0

### Minor Changes

- d2c85d1: Graduation works in icm workspaces (SW-72). Each context strategy now supplies its own decisions. In icm they are the `status: decided` sections of `stages/*/output/*.md`, one per heading, with id `stages/<stage>/output/<file>.md#<heading-slug>`. `werkmeister notes graduate`, the `werkmeister down` offer and the MCP `notes` `graduate` action scaffold them through the same `graduateNote` path jit uses. Their `graduating → graduated` state is kept in `.werkmeister/graduations.yml`, so the stage outputs are never rewritten. MCP `notes` `list` also returns the open `decisions`. jit is unchanged. The not-in-workspace error no longer names the old `.sandbox/` directory.

### Patch Changes

- werkmeister-core@0.32.0
- werkmeister-ui@0.5.2

## 0.5.1

### Patch Changes

- werkmeister-core@0.31.0
- werkmeister-ui@0.5.1

## 0.5.0

### Minor Changes

- 62e969a: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

### Patch Changes

- Updated dependencies [62e969a]
  - werkmeister-core@0.30.0
  - werkmeister-ui@0.5.0

## 0.4.8

### Patch Changes

- werkmeister-core@0.29.0
- werkmeister-ui@0.4.7

## 0.4.7

### Patch Changes

- Updated dependencies [cd828e1]
  - werkmeister-core@0.28.1
  - werkmeister-ui@0.4.6

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

- Updated dependencies [443da5d]
  - werkmeister-core@0.26.0
  - werkmeister-ui@0.4.2

## 0.4.2

### Patch Changes

- Updated dependencies [d4d5e01]
  - werkmeister-core@0.25.0
  - werkmeister-ui@0.4.1

## 0.4.1

### Patch Changes

- f510b53: SW-57: the rest of the UI is React. The chat panel, the options input, the usage breakdown, the create form's card and the dashboard's tab shell, Open Pull Requests, Health and Links tabs no longer use the vanilla-DOM `el()` / `injectCss()` helpers, which are gone. Each component renders its own stylesheet with `Css` (a React-hoisted `<style>`, one per component); the tokens stay CSS custom properties in `tokens.css`. `werkmeister-ui` now exports `ChatPanel`, `OptionsInput`, `Usage`, `CreateForm` and `WorkspaceList` in place of `initChatPanel`, `createOptionsInput` and `renderUsage`; `initWorkspaceUI` and `initCreateForm` keep their signatures. The workspace card takes `renderPanel(kind)` instead of `mountPanel(kind, host)`. On the Desktop-inline and Cowork surfaces an open chat now syncs the transcript every 3 s while a turn runs, as its polling was meant to, instead of only when the turn ends.
- Updated dependencies [f510b53]
  - werkmeister-ui@0.4.0
  - werkmeister-core@0.24.1

## 0.4.0

### Minor Changes

- 1ed01fe: SW-54: the dashboard and MCP App workspace card gains `↗ Continue in Desktop` and `＋ New session`, the top bar gains `＋ New workspace` (the MCP App list opens the create form in place), and the list gains a `☐ Focused only` filter. `claude-resume` takes `new: true` to open a fresh Terminal session.

### Patch Changes

- Updated dependencies [61780d5]
- Updated dependencies [138b15e]
- Updated dependencies [1ed01fe]
- Updated dependencies [e132f03]
  - werkmeister-core@0.24.0
  - werkmeister-ui@0.3.0

## 0.3.9

### Patch Changes

- f9017c7: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

- Updated dependencies [f9017c7]
  - werkmeister-core@0.23.0
  - werkmeister-ui@0.2.0

## 0.3.8

### Patch Changes

- 412e6c0: apps/mcp now builds the MCP App pages (`mcp-app.html`, `mcp-list.html`) itself, from the new `werkmeister-ui` package (`packages/sandbox-ui`), and serves them from its own `dist/`. The dashboard and apps/mcp share one copy of the UI modules, and `werkmeister-ui` adds the non-DOM display model the card, pane and VS Code will read.
- Updated dependencies [3f0542a]
- Updated dependencies [95598c3]
  - werkmeister-core@0.22.0
  - werkmeister-ui@0.1.1

## 0.3.7

### Patch Changes

- Updated dependencies [eb040c0]
- Updated dependencies [5f85354]
  - werkmeister-core@0.21.0

## 0.3.6

### Patch Changes

- Updated dependencies [002e00f]
  - werkmeister-core@0.20.0

## 0.3.5

### Patch Changes

- Updated dependencies [1e7d8a7]
  - werkmeister-core@0.19.0

## 0.3.4

### Patch Changes

- Updated dependencies [bd22bce]
- Updated dependencies [3936ebd]
- Updated dependencies [9420fd0]
- Updated dependencies [6f712a9]
  - werkmeister-core@0.18.0

## 0.3.3

### Patch Changes

- Updated dependencies [5ba6593]
  - werkmeister-core@0.17.0

## 0.3.2

### Patch Changes

- Updated dependencies [fef4b99]
- Updated dependencies [07e7d18]
- Updated dependencies [8b4a73d]
- Updated dependencies [844ccbf]
- Updated dependencies [70125e3]
- Updated dependencies [39eb67a]
- Updated dependencies [65ff7f9]
  - werkmeister-core@0.16.0

## 0.3.1

### Patch Changes

- Updated dependencies [f85e6af]
  - werkmeister-core@0.15.0

## 0.3.0

### Minor Changes

- 7e0a144: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- Updated dependencies [6ff0f46]
- Updated dependencies [99a2303]
- Updated dependencies [acf3e20]
- Updated dependencies [7e0a144]
  - sandbox-core@0.14.0

## 0.2.3

### Patch Changes

- Updated dependencies [0853f96]
  - sandbox-core@0.13.0

## 0.2.2

### Patch Changes

- Updated dependencies [e12539a]
  - sandbox-core@0.12.0

## 0.2.1

### Patch Changes

- 0f2892d: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).
- Updated dependencies [0f2892d]
  - sandbox-core@0.11.0

## 0.2.0

### Minor Changes

- 93adb9a: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

### Patch Changes

- Updated dependencies [93adb9a]
- Updated dependencies [ca13ea7]
- Updated dependencies [5247bbc]
  - sandbox-core@0.10.0

## 0.1.8

### Patch Changes

- Updated dependencies [5d23026]
- Updated dependencies [bc09b75]
- Updated dependencies [100e350]
  - sandbox-core@0.9.0

## 0.1.7

### Patch Changes

- Updated dependencies [88430c7]
- Updated dependencies [e40578c]
  - sandbox-core@0.8.0

## 0.1.6

### Patch Changes

- Updated dependencies [5f1c77f]
  - sandbox-core@0.7.0

## 0.1.5

### Patch Changes

- Updated dependencies [4485440]
  - sandbox-core@0.6.0

## 0.1.4

### Patch Changes

- sandbox-core@0.5.0

## 0.1.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - sandbox-core@0.4.0

## 0.1.2

### Patch Changes

- sandbox-core@0.3.0

## 0.1.1

### Patch Changes

- sandbox-core@0.2.0
