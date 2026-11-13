# werkmeister-ui

## 0.7.17

### Patch Changes

- werkmeister-core@0.87.3

## 0.7.16

### Patch Changes

- Updated dependencies [8a90281]
- Updated dependencies [aa2e36e]
- Updated dependencies [238b387]
  - werkmeister-core@0.87.2

## 0.7.15

### Patch Changes

- werkmeister-core@0.87.1

## 0.7.14

### Patch Changes

- werkmeister-core@0.87.0

## 0.7.13

### Patch Changes

- werkmeister-core@0.86.4

## 0.7.12

### Patch Changes

- Updated dependencies [dd1c412]
- Updated dependencies [7162800]
- Updated dependencies [5d768ab]
- Updated dependencies [c06f99d]
- Updated dependencies [44922a4]
- Updated dependencies [5030975]
  - werkmeister-core@0.86.3

## 0.7.11

### Patch Changes

- werkmeister-core@0.86.2

## 0.7.10

### Patch Changes

- Updated dependencies [e8f00dd]
- Updated dependencies [ae543b5]
  - werkmeister-core@0.86.1

## 0.7.9

### Patch Changes

- Updated dependencies [c8c721b]
  - werkmeister-core@0.86.0

## 0.7.8

### Patch Changes

- werkmeister-core@0.85.7

## 0.7.7

### Patch Changes

- Updated dependencies [ee7e229]
- Updated dependencies [1f39deb]
  - werkmeister-core@0.85.6

## 0.7.6

### Patch Changes

- Updated dependencies [bb9398d]
  - werkmeister-core@0.85.5

## 0.7.5

### Patch Changes

- werkmeister-core@0.85.4

## 0.7.4

### Patch Changes

- Updated dependencies [531e140]
  - werkmeister-core@0.85.3

## 0.7.3

### Patch Changes

- werkmeister-core@0.85.2

## 0.7.2

### Patch Changes

- werkmeister-core@0.85.1

## 0.7.1

### Patch Changes

- werkmeister-core@0.85.0

## 0.7.0

### Minor Changes

- e84d3bb: SW-577: every workspace now records an explicit model, picked by tier. `--model` takes a tier (`small`, `mid`, `frontier`, `advanced_frontier`) or an explicit model; blank means `models.default_tier` (frontier). A tier resolves at create/init through `models:` in `~/.werkmeister/config.yaml`, merged over the built-ins (claude: haiku / sonnet / opus / claude-fable-5-1; opencode: the same as `anthropic/…`), and the resolved model goes to workspace.yml and `.claude/settings.json`, so changing the config affects new workspaces only. Codex has no built-ins: set `models.codex.<tier>`, or `workspace new` on a Codex workspace, and `workspace init` in one that records no model yet, fails naming the key. Run `werkmeister machine migrate` once to write the default model into existing workspaces that record none (only `model`: their rules and hooks are left as they are). `werkmeister machine config` prints the tiers; `workspace list` and the workspace card show each workspace's model.

### Patch Changes

- Updated dependencies [e84d3bb]
  - werkmeister-core@0.84.0

## 0.6.5

### Patch Changes

- werkmeister-core@0.83.5

## 0.6.4

### Patch Changes

- werkmeister-core@0.83.4

## 0.6.3

### Patch Changes

- Updated dependencies [7f0c186]
  - werkmeister-core@0.83.3

## 0.6.2

### Patch Changes

- werkmeister-core@0.83.2

## 0.6.1

### Patch Changes

- werkmeister-core@0.83.1

## 0.6.0

### Minor Changes

- 6255c49: SW-487: one workspace state model in werkmeister-core. `WorkspaceStatus.workspaceState` gives each workspace a phase, an activity (thinking, running a tool or tests, a background agent, queued for CPU, paused, containers starting, idle, session gone) and a needs-you list. Each item has what, since, action and source: questions, permissions, plans, stage gates, a dead session, run the postmortem, close it, crash loops and system notices, plus CI failed, conflict, changes requested and merge it from `getWorkspacePRs()`. Hooks now keep one record per session (`.werkmeister/sessions/<id>.json`), so sessions and subagents can't overwrite each other's ask, and a crashed session reads as gone after 30 minutes. The /workspaces pane lists every item with its time and action, and check-in reads the same model. Run `werkmeister machine migrate` to add the new Claude Code hook events to existing workspaces.

### Patch Changes

- Updated dependencies [6255c49]
  - werkmeister-core@0.83.0

## 0.5.104

### Patch Changes

- Updated dependencies [1b060f6]
  - werkmeister-core@0.82.3

## 0.5.103

### Patch Changes

- werkmeister-core@0.82.2

## 0.5.102

### Patch Changes

- Updated dependencies [272cd4f]
  - werkmeister-core@0.82.1

## 0.5.101

### Patch Changes

- Updated dependencies [4a6a8b3]
- Updated dependencies [9e650ec]
- Updated dependencies [28828ce]
  - werkmeister-core@0.82.0

## 0.5.100

### Patch Changes

- Updated dependencies [532983f]
- Updated dependencies [7689f33]
- Updated dependencies [c04d525]
  - werkmeister-core@0.81.1

## 0.5.99

### Patch Changes

- Updated dependencies [315ea0c]
- Updated dependencies [4822338]
- Updated dependencies [3ef569b]
- Updated dependencies [8f25967]
  - werkmeister-core@0.81.0

## 0.5.98

### Patch Changes

- werkmeister-core@0.80.1

## 0.5.97

### Patch Changes

- Updated dependencies [24ae868]
  - werkmeister-core@0.80.0

## 0.5.96

### Patch Changes

- Updated dependencies [c9af0ba]
- Updated dependencies [53f0dc8]
- Updated dependencies [357d007]
  - werkmeister-core@0.79.4

## 0.5.95

### Patch Changes

- Updated dependencies [fdc8418]
- Updated dependencies [973a6e5]
- Updated dependencies [9e36c19]
- Updated dependencies [4e4fc2a]
  - werkmeister-core@0.79.3

## 0.5.94

### Patch Changes

- Updated dependencies [b5aa231]
- Updated dependencies [0ff080d]
- Updated dependencies [c40c1a9]
- Updated dependencies [491f366]
- Updated dependencies [97b0b89]
- Updated dependencies [1cb2086]
- Updated dependencies [ff8cbb8]
- Updated dependencies [c21edc6]
- Updated dependencies [4a0a958]
- Updated dependencies [d68fa02]
- Updated dependencies [e644b9c]
  - werkmeister-core@0.79.2

## 0.5.93

### Patch Changes

- Updated dependencies [965fbfc]
- Updated dependencies [5794317]
  - werkmeister-core@0.79.1

## 0.5.92

### Patch Changes

- Updated dependencies [e033938]
- Updated dependencies [2cce430]
- Updated dependencies [3484a52]
  - werkmeister-core@0.79.0

## 0.5.91

### Patch Changes

- werkmeister-core@0.78.0

## 0.5.90

### Patch Changes

- Updated dependencies [d16406b]
  - werkmeister-core@0.77.0

## 0.5.89

### Patch Changes

- werkmeister-core@0.76.1

## 0.5.88

### Patch Changes

- werkmeister-core@0.76.0

## 0.5.87

### Patch Changes

- werkmeister-core@0.75.0

## 0.5.86

### Patch Changes

- Updated dependencies [7090ac2]
- Updated dependencies [149111d]
  - werkmeister-core@0.74.0

## 0.5.85

### Patch Changes

- werkmeister-core@0.73.0

## 0.5.84

### Patch Changes

- werkmeister-core@0.72.1

## 0.5.83

### Patch Changes

- werkmeister-core@0.72.0

## 0.5.82

### Patch Changes

- werkmeister-core@0.71.3

## 0.5.81

### Patch Changes

- werkmeister-core@0.71.2

## 0.5.80

### Patch Changes

- werkmeister-core@0.71.1

## 0.5.79

### Patch Changes

- Updated dependencies [057962d]
  - werkmeister-core@0.71.0

## 0.5.78

### Patch Changes

- Updated dependencies [d99e9ea]
- Updated dependencies [924600e]
  - werkmeister-core@0.70.2

## 0.5.77

### Patch Changes

- werkmeister-core@0.70.1

## 0.5.76

### Patch Changes

- Updated dependencies [dd6aed2]
- Updated dependencies [c4263c6]
  - werkmeister-core@0.70.0

## 0.5.75

### Patch Changes

- Updated dependencies [2a72809]
  - werkmeister-core@0.69.0

## 0.5.74

### Patch Changes

- Updated dependencies [b442dfd]
- Updated dependencies [9368784]
- Updated dependencies [2c525f2]
  - werkmeister-core@0.68.0

## 0.5.73

### Patch Changes

- Updated dependencies [b0496a9]
  - werkmeister-core@0.67.0

## 0.5.72

### Patch Changes

- Updated dependencies [8efb3ce]
  - werkmeister-core@0.66.3

## 0.5.71

### Patch Changes

- Updated dependencies [adf5e2a]
- Updated dependencies [99e3380]
  - werkmeister-core@0.66.2

## 0.5.70

### Patch Changes

- Updated dependencies [c5b8878]
  - werkmeister-core@0.66.1

## 0.5.69

### Patch Changes

- Updated dependencies [2da3414]
- Updated dependencies [d543024]
- Updated dependencies [a2a7db3]
  - werkmeister-core@0.66.0

## 0.5.68

### Patch Changes

- Updated dependencies [7fa111c]
  - werkmeister-core@0.65.0

## 0.5.67

### Patch Changes

- Updated dependencies [3c8f294]
  - werkmeister-core@0.64.2

## 0.5.66

### Patch Changes

- Updated dependencies [d1f17bc]
- Updated dependencies [ce1256e]
- Updated dependencies [3223e06]
  - werkmeister-core@0.64.1

## 0.5.65

### Patch Changes

- Updated dependencies [a34b387]
- Updated dependencies [90c30e8]
  - werkmeister-core@0.64.0

## 0.5.64

### Patch Changes

- Updated dependencies [7b92579]
  - werkmeister-core@0.63.0

## 0.5.63

### Patch Changes

- Updated dependencies [63f4d97]
  - werkmeister-core@0.62.1

## 0.5.62

### Patch Changes

- Updated dependencies [506e04b]
  - werkmeister-core@0.62.0

## 0.5.61

### Patch Changes

- Updated dependencies [c0b4184]
- Updated dependencies [1843168]
  - werkmeister-core@0.61.0

## 0.5.60

### Patch Changes

- Updated dependencies [a9d211b]
  - werkmeister-core@0.60.2

## 0.5.59

### Patch Changes

- Updated dependencies [9238da2]
- Updated dependencies [35c2dd8]
- Updated dependencies [316d1d6]
  - werkmeister-core@0.60.1

## 0.5.58

### Patch Changes

- Updated dependencies [c73f9ee]
- Updated dependencies [429226a]
  - werkmeister-core@0.60.0

## 0.5.57

### Patch Changes

- Updated dependencies [ab40ce4]
  - werkmeister-core@0.59.4

## 0.5.56

### Patch Changes

- Updated dependencies [a68920b]
  - werkmeister-core@0.59.3

## 0.5.55

### Patch Changes

- Updated dependencies [c87d8b7]
  - werkmeister-core@0.59.2

## 0.5.54

### Patch Changes

- Updated dependencies [db3505a]
  - werkmeister-core@0.59.1

## 0.5.53

### Patch Changes

- Updated dependencies [6e4707d]
- Updated dependencies [0b6e9c3]
- Updated dependencies [d7ba2ba]
  - werkmeister-core@0.59.0

## 0.5.52

### Patch Changes

- Updated dependencies [80b6117]
  - werkmeister-core@0.58.0

## 0.5.51

### Patch Changes

- Updated dependencies [1cbdd5d]
- Updated dependencies [11d002e]
  - werkmeister-core@0.57.0

## 0.5.50

### Patch Changes

- Updated dependencies [d8c9205]
  - werkmeister-core@0.56.0

## 0.5.49

### Patch Changes

- Updated dependencies [a1a40a1]
- Updated dependencies [378260d]
- Updated dependencies [6cf6e82]
  - werkmeister-core@0.55.1

## 0.5.48

### Patch Changes

- Updated dependencies [b64c8ea]
- Updated dependencies [5816545]
- Updated dependencies [662dcfd]
- Updated dependencies [1200605]
- Updated dependencies [3e0b4a0]
- Updated dependencies [2237edb]
  - werkmeister-core@0.55.0

## 0.5.47

### Patch Changes

- Updated dependencies [eaa500b]
  - werkmeister-core@0.54.0

## 0.5.46

### Patch Changes

- Updated dependencies [c22be3d]
  - werkmeister-core@0.53.0

## 0.5.45

### Patch Changes

- Updated dependencies [29a1404]
- Updated dependencies [a69799c]
  - werkmeister-core@0.52.1

## 0.5.44

### Patch Changes

- Updated dependencies [d1fc18a]
- Updated dependencies [e75909c]
- Updated dependencies [a8203cc]
  - werkmeister-core@0.52.0

## 0.5.43

### Patch Changes

- Updated dependencies [5e12dac]
  - werkmeister-core@0.51.1

## 0.5.42

### Patch Changes

- Updated dependencies [a6b8980]
  - werkmeister-core@0.51.0

## 0.5.41

### Patch Changes

- Updated dependencies [f9a45e5]
  - werkmeister-core@0.50.2

## 0.5.40

### Patch Changes

- Updated dependencies [18d4490]
- Updated dependencies [16e90f7]
- Updated dependencies [5d2bdcf]
  - werkmeister-core@0.50.1

## 0.5.39

### Patch Changes

- Updated dependencies [050e6a6]
  - werkmeister-core@0.50.0

## 0.5.38

### Patch Changes

- werkmeister-core@0.49.0

## 0.5.37

### Patch Changes

- Updated dependencies [2209de7]
  - werkmeister-core@0.48.0

## 0.5.36

### Patch Changes

- werkmeister-core@0.47.4

## 0.5.35

### Patch Changes

- Updated dependencies [169783d]
  - werkmeister-core@0.47.3

## 0.5.34

### Patch Changes

- Updated dependencies [6de7585]
  - werkmeister-core@0.47.2

## 0.5.33

### Patch Changes

- Updated dependencies [74e0654]
  - werkmeister-core@0.47.1

## 0.5.32

### Patch Changes

- Updated dependencies [5556fd4]
- Updated dependencies [ddf7977]
- Updated dependencies [9b2283a]
  - werkmeister-core@0.47.0

## 0.5.31

### Patch Changes

- Updated dependencies [9273365]
- Updated dependencies [59b5340]
- Updated dependencies [d688847]
  - werkmeister-core@0.46.0

## 0.5.30

### Patch Changes

- Updated dependencies [493cff4]
  - werkmeister-core@0.45.0

## 0.5.29

### Patch Changes

- Updated dependencies [8ba5b70]
  - werkmeister-core@0.44.4

## 0.5.28

### Patch Changes

- Updated dependencies [65e4060]
  - werkmeister-core@0.44.3

## 0.5.27

### Patch Changes

- Updated dependencies [ff1cff8]
- Updated dependencies [09d62c8]
- Updated dependencies [c380936]
  - werkmeister-core@0.44.2

## 0.5.26

### Patch Changes

- werkmeister-core@0.44.1

## 0.5.25

### Patch Changes

- werkmeister-core@0.44.0

## 0.5.24

### Patch Changes

- Updated dependencies [3bd6bf5]
- Updated dependencies [75bdd3d]
  - werkmeister-core@0.43.0

## 0.5.23

### Patch Changes

- Updated dependencies [ba48455]
  - werkmeister-core@0.42.0

## 0.5.22

### Patch Changes

- Updated dependencies [810e41b]
- Updated dependencies [2290eeb]
  - werkmeister-core@0.41.0

## 0.5.21

### Patch Changes

- Updated dependencies [4fc26a8]
  - werkmeister-core@0.40.0

## 0.5.20

### Patch Changes

- Updated dependencies [c0d2c42]
  - werkmeister-core@0.39.0

## 0.5.19

### Patch Changes

- werkmeister-core@0.38.1

## 0.5.18

### Patch Changes

- werkmeister-core@0.38.0

## 0.5.17

### Patch Changes

- Updated dependencies [5b37069]
  - werkmeister-core@0.37.1

## 0.5.16

### Patch Changes

- Updated dependencies [fa98c10]
  - werkmeister-core@0.37.0

## 0.5.15

### Patch Changes

- werkmeister-core@0.36.2

## 0.5.14

### Patch Changes

- Updated dependencies [67637e6]
  - werkmeister-core@0.36.1

## 0.5.13

### Patch Changes

- Updated dependencies [7fa838e]
- Updated dependencies [9dfc1cc]
  - werkmeister-core@0.36.0

## 0.5.12

### Patch Changes

- werkmeister-core@0.35.5

## 0.5.11

### Patch Changes

- Updated dependencies [8dd972e]
  - werkmeister-core@0.35.4

## 0.5.10

### Patch Changes

- Updated dependencies [e3c5ec9]
  - werkmeister-core@0.35.3

## 0.5.9

### Patch Changes

- werkmeister-core@0.35.2

## 0.5.8

### Patch Changes

- Updated dependencies [6d24ff6]
  - werkmeister-core@0.35.1

## 0.5.7

### Patch Changes

- Updated dependencies [8666887]
  - werkmeister-core@0.35.0

## 0.5.6

### Patch Changes

- Updated dependencies [8c99ce9]
- Updated dependencies [157e9e8]
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

- 62e969a: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

### Patch Changes

- Updated dependencies [62e969a]
  - werkmeister-core@0.30.0

## 0.4.7

### Patch Changes

- werkmeister-core@0.29.0

## 0.4.6

### Patch Changes

- Updated dependencies [cd828e1]
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

- Updated dependencies [443da5d]
  - werkmeister-core@0.26.0

## 0.4.1

### Patch Changes

- Updated dependencies [d4d5e01]
  - werkmeister-core@0.25.0

## 0.4.0

### Minor Changes

- f510b53: SW-57: the rest of the UI is React. The chat panel, the options input, the usage breakdown, the create form's card and the dashboard's tab shell, Open Pull Requests, Health and Links tabs no longer use the vanilla-DOM `el()` / `injectCss()` helpers, which are gone. Each component renders its own stylesheet with `Css` (a React-hoisted `<style>`, one per component); the tokens stay CSS custom properties in `tokens.css`. `werkmeister-ui` now exports `ChatPanel`, `OptionsInput`, `Usage`, `CreateForm` and `WorkspaceList` in place of `initChatPanel`, `createOptionsInput` and `renderUsage`; `initWorkspaceUI` and `initCreateForm` keep their signatures. The workspace card takes `renderPanel(kind)` instead of `mountPanel(kind, host)`. On the Desktop-inline and Cowork surfaces an open chat now syncs the transcript every 3 s while a turn runs, as its polling was meant to, instead of only when the turn ends.

### Patch Changes

- werkmeister-core@0.24.1

## 0.3.0

### Minor Changes

- 61780d5: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.
- 1ed01fe: SW-54: the dashboard and MCP App workspace card gains `↗ Continue in Desktop` and `＋ New session`, the top bar gains `＋ New workspace` (the MCP App list opens the create form in place), and the list gains a `☐ Focused only` filter. `claude-resume` takes `new: true` to open a fresh Terminal session.

### Patch Changes

- Updated dependencies [61780d5]
- Updated dependencies [138b15e]
- Updated dependencies [1ed01fe]
- Updated dependencies [e132f03]
  - werkmeister-core@0.24.0

## 0.2.0

### Minor Changes

- f9017c7: The dashboard, the Cowork artifact and the MCP App show the handoff workspace card, rebuilt in React in `werkmeister-ui` (SW-53). Each workspace is one always-expanded card: the agent chip (solid amber only for `● Needs you`, with the last question), the work type and task title, the issue, then Containers, PRs (state badge, dashed for Draft, and CI), Workflow (stage pips or the lifecycle step) and Agent rows. The action bar shows the primary action and two secondaries; the rest are in `⋯`, which also opens Chat, Usage and Logs. Close out and `✕ Abandon…` confirm inline in the footer, and Abandon needs a reason; "Click again to confirm" is gone. The page gains a loading skeleton, a restyled top bar, a Needs-you filter and a legend. The new tokens (`tokens.css`, light and dark) replace the old palette, with Barlow and IBM Plex Mono inlined as woff2, so no font is fetched.

  `listWorkspaces()` (and the `list-workspaces` tool) adds `task`, `workType` and `lifecycle` to each workspace. `RepoPr` adds `draft`, and `workspace-prs` now declares `ci`, `failingChecks` and `draft`. The `logs` tool returns its lines as `output` in its structured content too.

### Patch Changes

- Updated dependencies [f9017c7]
  - werkmeister-core@0.23.0

## 0.1.1

### Patch Changes

- Updated dependencies [3f0542a]
- Updated dependencies [95598c3]
  - werkmeister-core@0.22.0
