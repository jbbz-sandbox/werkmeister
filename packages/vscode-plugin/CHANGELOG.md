# vscode-plugin

## 0.22.0

### Patch Changes

- 3fdbf6d: `werkmeister logs`, the MCP `logs` tool and the VS Code logs pane read container logs from the Docker Engine API instead of running `docker compose logs` (SW-61). The output is the same: compose's `name | ` prefix, coloured per service, coloured only onto a terminal for the CLI and always in the pane. An unknown service prints `no such service: <name>`. A followed tail now picks up containers that start or restart after it began. The VS Code pane no longer needs `docker` on PATH, so it works from a VS Code launched from the Dock. `composeLogsStream` returns a `{ stop(), done }` handle instead of a `ChildProcess`, and loses its `env` parameter; `composeLogsArgs` is gone.
- Updated dependencies [58a61bd]
- Updated dependencies [3fdbf6d]
  - werkmeister-core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [084b453]
- Updated dependencies [e4adda8]
  - werkmeister-core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [afc375a]
  - werkmeister-core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [0ec96f9]
  - werkmeister-core@0.19.0

## 0.18.0

### Patch Changes

- 963da69: The Workspaces pane and the VS Code tree no longer show an intercept control on local-only services such as CLIs and libraries, which Telepresence can never intercept. `sandbox status --intercepts --json` has a new `remote_services` list, present whether or not Telepresence is available, naming the registry services that have `k8s_deployment`, `k8s_namespace` and `k8s_port`. Remote services keep every state they had, including a disabled control when `k8s_port_name` is missing.
- fc35a8e: Stub dockerode's session-only `@grpc/*` requires in the extension bundle, so the esbuild watch build no longer fails (and crash-loops its container) when they are not installed; the bundle also shrinks by about 2 MB.
- Updated dependencies [963da69]
- Updated dependencies [28e39b6]
- Updated dependencies [cfea47d]
- Updated dependencies [8a0c8b4]
  - werkmeister-core@0.18.0

## 0.17.1

### Patch Changes

- werkmeister-core@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies [8c2a1eb]
  - werkmeister-core@0.17.0

## 0.16.0

### Patch Changes

- 7035cff: Docs sweep for the Werkmeister rename (SW-10). The README and `docs/` now call the tool Werkmeister, show `werkmeister` (or `w9r`) in every command, and use `~/.werkmeister` and `<workspace>/.werkmeister/`, with a note that the old `~/.sandbox` and `.sandbox/` are still read. The clone steps no longer `cd sandbox`. No behaviour change. The `sandbox` bin, `SANDBOX_*` variables, container names and a repo's `.sandbox/services.yaml` fragment keep their names.
- Updated dependencies [7035cff]
- Updated dependencies [183a2e9]
- Updated dependencies [7d121e8]
- Updated dependencies [4e08dd6]
- Updated dependencies [fe14381]
- Updated dependencies [88fb0e3]
- Updated dependencies [4240fba]
  - werkmeister-core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [dba74e3]
  - werkmeister-core@0.15.0

## 0.14.1

### Patch Changes

- werkmeister-core@0.14.1

## 0.14.0

### Minor Changes

- 5e11f2a: Werkmeister rename, config side (SW-7): the tool now reads `~/.werkmeister` and each workspace's `.werkmeister/` first, falling back to `~/.sandbox` and `.sandbox/` when the new directory is missing. Nothing is moved, so existing installs and workspaces keep working unchanged. A fresh machine gets `~/.werkmeister`, and a new workspace gets `.werkmeister/`, along with generated docs that name it. Every `SANDBOX_*` variable the tool reads now also accepts a `WERKMEISTER_*` name, which wins when both are set. The names the tool exports (env.sh, compose and container env, `.env`, the generated MCP config) stay `SANDBOX_*` for now. The VS Code extension's `sandbox.root`/`sandbox.binPath` settings are now applied as `WERKMEISTER_ROOT`/`WERKMEISTER_BIN`, so they still beat an inherited env var.

### Patch Changes

- Updated dependencies [ccdb6a0]
- Updated dependencies [192c2f2]
- Updated dependencies [cc2806e]
- Updated dependencies [5e11f2a]
  - sandbox-core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [d5b1a9a]
  - sandbox-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [aba829c]
  - sandbox-core@0.12.0

## 0.11.0

### Patch Changes

- 2f106fc: Workspaces now get `compose.yml`, the Compose v2 preferred name, instead of `docker-compose.yml` (#224). An existing workspace's file is renamed on the next `sandbox init-workspace` or `sandbox up`; until then `down`, `logs` and `close-out` still read `docker-compose.yml`, so a running stack is never orphaned (Compose keys it by project `name:`, which is unchanged).
- Updated dependencies [2f106fc]
  - sandbox-core@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [da18100]
  - sandbox-core@0.10.1

## 0.10.0

### Minor Changes

- afd99d4: Close-out is the one end-of-workspace verb (#160). `sandbox close-out <ws> --abandon "<reason>"` ends a workspace whose work won't ship: it records the reason, leaves the issue, pushes every branch and keeps them, then removes the workspace. Both outcomes list terminal Claude sessions still open in the workspace. The pane shows one end button per card: ✓ Close out once shipped, otherwise ✕ Abandon… with a reason field. After a close-out, the pane and the `close-out` MCP tool archive the workspace's desktop sessions. The `remove-workspace` MCP tool, the pane's ✕ Remove and VS Code's Remove Workspace are gone; VS Code has Close Out Workspace. `sandbox remove-workspace` still works for one release but prints a deprecation notice.

  `closeOut(name, opts, deps)` now takes `{ abandon }` as its second argument, and `deps` moves to the third.

### Patch Changes

- Updated dependencies [afd99d4]
- Updated dependencies [63fdd7b]
- Updated dependencies [a671c9f]
  - sandbox-core@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [304bb5c]
  - sandbox-core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [09c0746]
- Updated dependencies [5d20904]
- Updated dependencies [69a386d]
  - sandbox-core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [594efe1]
- Updated dependencies [542eecf]
  - sandbox-core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [1f9039f]
  - sandbox-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [2d701e4]
  - sandbox-core@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [47a7667]
  - sandbox-core@0.5.1

## 0.5.0

### Patch Changes

- sandbox-core@0.5.0

## 0.4.0

### Patch Changes

- e8bd4fe: "New Workspace" no longer asks for a Jira ticket in an input box first; the CLI's terminal wizard collects it with the other fields.
- Updated dependencies [6f38fc7]
- Updated dependencies [6d2333e]
- Updated dependencies [4ff0cc7]
- Updated dependencies [9a89e99]
  - sandbox-core@0.4.0

## 0.3.0

### Minor Changes

- 13bae18: Add "Detect Services in Repo..." and "Sync Service Registry" to the Workspaces view's `...` menu and the palette; both run the `sandbox` CLI in a terminal. Fix extension activation failing on jsonc-parser's unbundled UMD require.

### Patch Changes

- sandbox-core@0.3.0
