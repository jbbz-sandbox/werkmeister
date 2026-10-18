# sandbox-mcp

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
