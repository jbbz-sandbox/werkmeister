# vscode-plugin

## 0.44.4

### Patch Changes

- Updated dependencies [8ba5b70]
  - werkmeister-core@0.44.4
  - werkmeister-ui@0.5.29

## 0.44.3

### Patch Changes

- Updated dependencies [65e4060]
  - werkmeister-core@0.44.3
  - werkmeister-ui@0.5.28

## 0.44.2

### Patch Changes

- Updated dependencies [ff1cff8]
- Updated dependencies [09d62c8]
- Updated dependencies [c380936]
  - werkmeister-core@0.44.2
  - werkmeister-ui@0.5.27

## 0.44.1

### Patch Changes

- werkmeister-core@0.44.1
- werkmeister-ui@0.5.26

## 0.44.0

### Patch Changes

- werkmeister-core@0.44.0
- werkmeister-ui@0.5.25

## 0.43.0

### Patch Changes

- Updated dependencies [3bd6bf5]
- Updated dependencies [75bdd3d]
  - werkmeister-core@0.43.0
  - werkmeister-ui@0.5.24

## 0.42.0

### Patch Changes

- Updated dependencies [ba48455]
  - werkmeister-core@0.42.0
  - werkmeister-ui@0.5.23

## 0.41.0

### Patch Changes

- Updated dependencies [810e41b]
- Updated dependencies [2290eeb]
  - werkmeister-core@0.41.0
  - werkmeister-ui@0.5.22

## 0.40.0

### Patch Changes

- Updated dependencies [4fc26a8]
  - werkmeister-core@0.40.0
  - werkmeister-ui@0.5.21

## 0.39.0

### Patch Changes

- Updated dependencies [c0d2c42]
  - werkmeister-core@0.39.0
  - werkmeister-ui@0.5.20

## 0.38.1

### Patch Changes

- werkmeister-core@0.38.1
- werkmeister-ui@0.5.19

## 0.38.0

### Patch Changes

- werkmeister-core@0.38.0
- werkmeister-ui@0.5.18

## 0.37.1

### Patch Changes

- Updated dependencies [5b37069]
  - werkmeister-core@0.37.1
  - werkmeister-ui@0.5.17

## 0.37.0

### Patch Changes

- Updated dependencies [fa98c10]
  - werkmeister-core@0.37.0
  - werkmeister-ui@0.5.16

## 0.36.2

### Patch Changes

- werkmeister-core@0.36.2
- werkmeister-ui@0.5.15

## 0.36.1

### Patch Changes

- Updated dependencies [67637e6]
  - werkmeister-core@0.36.1
  - werkmeister-ui@0.5.14

## 0.36.0

### Patch Changes

- 7fa838e: SW-93: the Docker-side names and default domains no longer say "sandbox". New containers carry `com.werkmeister.*` labels, compose projects and per-feature networks are `werkmeister-<feature>`, features join the `werkmeister-shared` network, the built-in build caches live in `werkmeister-<key>` volumes, and the sandbox repo's setup service is `werkmeister-install`. A workspace brought up before this keeps running under its old `sandbox-<feature>` project and `com.sandbox.local.*` labels: slots, `status`, `stop`, `restart`, `logs`, the VS Code tree and the idle reaper all still find it, and its next `up` takes the old project down (keeping its node_modules volumes) before starting the new one. `down` and `close-out` remove both. Caddy and k8s-forwards join both shared networks, and `cache prune` also reaches a leftover `sandbox-<key>` volume. A fragment still naming its setup `sandbox-install` gets the renamed startup script. The default `local_domain`/`remote_domain` are now `local.werkmeister.io`/`remote.werkmeister.io`; a machine whose `config.yaml` sets them (every `setup` run writes them) keeps its own. The X-Feature cookie, the `connect` tool links and the docs-site's allowed hosts (a new `{{local_domain}}` registry placeholder) follow the configured domain instead of a hard-coded `local.sandbox.com`. SW-11 removes the old-name fallbacks.
- 9dfc1cc: SW-92: `werkmeister migrate` moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml` values, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch launchd agent (or crontab line) and each workspace's compose file. It refuses while a container that mounts the old home, or any workspace container, is running. A second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`, and `--check` reports without writing. Registry sync, `detect` and the pre-PR gate now read `<repo>/.werkmeister/services.yaml` first and fall back to `<repo>/.sandbox/services.yaml`. `detect` writes new fragments under `.werkmeister/`. Fragments can use `{{werkmeister_home}}` for the tool's home folder. This repo's fragment moved to `.werkmeister/services.yaml` and uses it, so **pull and rebuild the CLI before the next `registry sync`**: an older build skips the moved fragment. Docs, help text and generated text now say `~/.werkmeister`, with `~/.sandbox` named only as the legacy name.
- Updated dependencies [7fa838e]
- Updated dependencies [9dfc1cc]
  - werkmeister-core@0.36.0
  - werkmeister-ui@0.5.13

## 0.35.5

### Patch Changes

- werkmeister-core@0.35.5
- werkmeister-ui@0.5.12

## 0.35.4

### Patch Changes

- Updated dependencies [8dd972e]
  - werkmeister-core@0.35.4
  - werkmeister-ui@0.5.11

## 0.35.3

### Patch Changes

- Updated dependencies [e3c5ec9]
  - werkmeister-core@0.35.3
  - werkmeister-ui@0.5.10

## 0.35.2

### Patch Changes

- werkmeister-core@0.35.2
- werkmeister-ui@0.5.9

## 0.35.1

### Patch Changes

- Updated dependencies [6d24ff6]
  - werkmeister-core@0.35.1
  - werkmeister-ui@0.5.8

## 0.35.0

### Patch Changes

- Updated dependencies [8666887]
  - werkmeister-core@0.35.0
  - werkmeister-ui@0.5.7

## 0.34.0

### Patch Changes

- Updated dependencies [8c99ce9]
- Updated dependencies [157e9e8]
  - werkmeister-core@0.34.0
  - werkmeister-ui@0.5.6

## 0.33.2

### Patch Changes

- werkmeister-core@0.33.2
- werkmeister-ui@0.5.5

## 0.33.1

### Patch Changes

- werkmeister-core@0.33.1
- werkmeister-ui@0.5.4

## 0.33.0

### Patch Changes

- werkmeister-core@0.33.0
- werkmeister-ui@0.5.3

## 0.32.0

### Patch Changes

- 59fb856: Ship `LICENSE`, `NOTICE` and `THIRD-PARTY-LICENSES.txt` (the licence text of every package inlined into `extension.cjs`) in the .vsix, so vsce no longer warns "LICENSE not found" (SW-74). The extension build now shares `scripts/write-licenses.mjs` with `apps/cli`.
  - werkmeister-core@0.32.0
  - werkmeister-ui@0.5.2

## 0.31.0

### Patch Changes

- werkmeister-core@0.31.0
- werkmeister-ui@0.5.1

## 0.30.0

### Minor Changes

- 62e969a: Pause and Resume a workspace (SW-70). `werkmeister pause` and the `pause` MCP tool freeze the workspace's running containers (`docker pause`, `-sandbox-install` included) and hold its Claude session: while `.werkmeister/paused.json` exists, the agent-state hook ends the turn at the next tool call and blocks new prompts. `werkmeister resume` and `resume` thaw exactly those containers, starting any stopped meanwhile, release the session and, when Pause cut a working turn, tell it to continue: headless through claude-send, a Desktop session through the Workspaces pane. Every card, `status` and `check-in` show `paused`, and a paused workspace is never a check-in candidate. `up` and `restart` refuse while paused; `down` ends the pause. The card bar on a running workspace is now `■ Stop · ⏸ Pause` with `↻ Restart` in ⋯; VS Code's Stop icon is now a square.

### Patch Changes

- Updated dependencies [62e969a]
  - werkmeister-core@0.30.0
  - werkmeister-ui@0.5.0

## 0.29.0

### Patch Changes

- werkmeister-core@0.29.0
- werkmeister-ui@0.4.7

## 0.28.1

### Patch Changes

- Updated dependencies [cd828e1]
  - werkmeister-core@0.28.1
  - werkmeister-ui@0.4.6

## 0.28.0

### Patch Changes

- werkmeister-core@0.28.0
- werkmeister-ui@0.4.5

## 0.27.0

### Patch Changes

- werkmeister-core@0.27.0
- werkmeister-ui@0.4.4

## 0.26.1

### Patch Changes

- werkmeister-core@0.26.1
- werkmeister-ui@0.4.3

## 0.26.0

### Minor Changes

- 443da5d: SW-12: start an intercept from the Workspaces pane when Telepresence is installed but not connected.

  - **Snapshot.** `sandbox status --intercepts --json` gains `installed`: true whenever the binary is on PATH, connected or not. `available` keeps its meaning (the daemon answered). When installed but disconnected, the snapshot now carries the rows, every one `intercepted: false`.
  - **No daemon launch on a poll.** The intercept read runs `telepresence status` first and `list -i` only against a connected daemon. Before this, every poll's `list` implicitly connected, launching a user daemon each time.
  - **Pane.** Installed but disconnected, an interceptable service shows `Intercept`. Its confirm line adds "Connects telepresence (docker) first." The pane starts and leaves intercepts in docker mode (`connect --docker`), since it has no TTY for host mode's sudo prompt. Not installed still reads `intercepts unavailable`. A core older than this falls back to `available`.
  - **Two daemons.** Any unqualified telepresence call can start a host user daemon beside the docker one, and telepresence then refuses unqualified commands. Docker-mode connect checks, intercepts and leaves (detach, agent uninstall, quit) now pass `--use <context>-<namespace>-cn`. The snapshot reads whichever daemon is connected.
  - **CLI / VS Code.** `sandbox status --intercepts` prints "not connected — `sandbox intercept` connects first." plus the rows. `sandbox intercept --leave --docker-daemon` leaves through the docker daemon. The VS Code tree keeps a disconnected service interceptable, noting "telepresence not connected".

  Core API:

  - `InterceptState` gains `installed` and `namespace`; `InterceptsSnapshot` and `InterceptsResult` gain `installed`.
  - New `dockerDaemonName()`; `LeaveInterceptArgs` gains `dockerDaemon`.

### Patch Changes

- Updated dependencies [443da5d]
  - werkmeister-core@0.26.0
  - werkmeister-ui@0.4.2

## 0.25.0

### Patch Changes

- Updated dependencies [d4d5e01]
  - werkmeister-core@0.25.0
  - werkmeister-ui@0.4.1

## 0.24.1

### Patch Changes

- Updated dependencies [f510b53]
  - werkmeister-ui@0.4.0
  - werkmeister-core@0.24.1

## 0.24.0

### Minor Changes

- 61780d5: Per-workspace container vitals (SW-41). `sandbox status`, the Workspaces pane and the VS Code tree show each workspace's CPU and memory (one stats sweep, every 30 s in the pane and the tree), when its containers started and by what (`up`, `gate`, `restart` or `person`, from `.werkmeister/starts.json`), and a crash-looping container as an error with its last log line, within one 5 s poll. The pane and the tree also show a host line: load average and the total CPU of feature containers. Core: `WorkspaceStatus` gains `started` and `crashLoops`, `sandbox status --json` gains `host` and per-feature `cpu_percent`, `mem_mib`, `started_at`, `started_by` and `crash_loops`, and new `getWorkspaceResources()`.

### Patch Changes

- 138b15e: Create form (SW-51): Work type and Workflow are preselected on every GUI, labels drop the terminal hints ("blank to skip", "Enter for default") and follow docs/ui-spec.md, VS Code's New Workspace runs the wizard from the workspaces root instead of ~, and the terminal wizard requires at least one service or repo.
- Updated dependencies [61780d5]
- Updated dependencies [138b15e]
- Updated dependencies [1ed01fe]
- Updated dependencies [e132f03]
  - werkmeister-core@0.24.0
  - werkmeister-ui@0.3.0

## 0.23.0

### Minor Changes

- 82707cf: SW-55: the VS Code Workspaces tree follows the unified card spec. Each workspace's description spells out the agent state, containers, stage and issue (`● Needs you · 2 of 2 up · stage 2/4 · #143`), and its icon follows the agent. The tooltip shows the full Containers / PRs / Workflow / Agent rows, with `⚙ Autonomous` and the agent's question. Colours use board 09's tone map, and PRs appear as child rows. New actions: `↗ Continue in Terminal`, `＋ New session`, `↻ Refresh PRs`, `Open PR ↗`, `⚡ Connect infra` and a `?` legend. "Close Out Workspace..." is split into `✓ Close out` and `✕ Abandon…`.

### Patch Changes

- Updated dependencies [f9017c7]
  - werkmeister-core@0.23.0
  - werkmeister-ui@0.2.0

## 0.22.0

### Patch Changes

- 95598c3: `werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.
- Updated dependencies [3f0542a]
- Updated dependencies [95598c3]
  - werkmeister-core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [eb040c0]
- Updated dependencies [5f85354]
  - werkmeister-core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [002e00f]
  - werkmeister-core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [1e7d8a7]
  - werkmeister-core@0.19.0

## 0.18.0

### Patch Changes

- bd22bce: The Workspaces pane and the VS Code tree no longer show an intercept control on local-only services such as CLIs and libraries, which Telepresence can never intercept. `sandbox status --intercepts --json` has a new `remote_services` list, present whether or not Telepresence is available, naming the registry services that have `k8s_deployment`, `k8s_namespace` and `k8s_port`. Remote services keep every state they had, including a disabled control when `k8s_port_name` is missing.
- da11c55: Stub dockerode's session-only `@grpc/*` requires in the extension bundle, so the esbuild watch build no longer fails (and crash-loops its container) when they are not installed; the bundle also shrinks by about 2 MB.
- Updated dependencies [bd22bce]
- Updated dependencies [3936ebd]
- Updated dependencies [9420fd0]
- Updated dependencies [6f712a9]
  - werkmeister-core@0.18.0

## 0.17.1

### Patch Changes

- werkmeister-core@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies [5ba6593]
  - werkmeister-core@0.17.0

## 0.16.0

### Patch Changes

- fef4b99: Docs sweep for the Werkmeister rename (SW-10). The README and `docs/` now call the tool Werkmeister, show `werkmeister` (or `w9r`) in every command, and use `~/.werkmeister` and `<workspace>/.werkmeister/`, with a note that the old `~/.sandbox` and `.sandbox/` are still read. The clone steps no longer `cd sandbox`. No behaviour change. The `sandbox` bin, `SANDBOX_*` variables, container names and a repo's `.sandbox/services.yaml` fragment keep their names.
- Updated dependencies [fef4b99]
- Updated dependencies [07e7d18]
- Updated dependencies [8b4a73d]
- Updated dependencies [844ccbf]
- Updated dependencies [70125e3]
- Updated dependencies [39eb67a]
- Updated dependencies [65ff7f9]
  - werkmeister-core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f85e6af]
  - werkmeister-core@0.15.0

## 0.14.1

### Patch Changes

- werkmeister-core@0.14.1

## 0.14.0

### Minor Changes

- 7e0a144: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- Updated dependencies [6ff0f46]
- Updated dependencies [99a2303]
- Updated dependencies [acf3e20]
- Updated dependencies [7e0a144]
  - sandbox-core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [0853f96]
  - sandbox-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e12539a]
  - sandbox-core@0.12.0

## 0.11.0

### Patch Changes

- 0f2892d: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).
- Updated dependencies [0f2892d]
  - sandbox-core@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [db54e57]
  - sandbox-core@0.10.1

## 0.10.0

### Minor Changes

- 93adb9a: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

### Patch Changes

- Updated dependencies [93adb9a]
- Updated dependencies [ca13ea7]
- Updated dependencies [5247bbc]
  - sandbox-core@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [4d0219c]
  - sandbox-core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [5d23026]
- Updated dependencies [bc09b75]
- Updated dependencies [100e350]
  - sandbox-core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [88430c7]
- Updated dependencies [e40578c]
  - sandbox-core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [5f1c77f]
  - sandbox-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [4485440]
  - sandbox-core@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [0bb624c]
  - sandbox-core@0.5.1

## 0.5.0

### Patch Changes

- sandbox-core@0.5.0

## 0.4.0

### Patch Changes

- "New Workspace" no longer asks for a Jira ticket in an input box first; the CLI's terminal wizard collects it with the other fields.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - sandbox-core@0.4.0

## 0.3.0

### Minor Changes

- Add "Detect Services in Repo..." and "Sync Service Registry" to the Workspaces view's `...` menu and the palette; both run the `sandbox` CLI in a terminal. Fix extension activation failing on jsonc-parser's unbundled UMD require.

### Patch Changes

- sandbox-core@0.3.0
