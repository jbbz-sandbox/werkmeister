# Sandbox Workspaces (VS Code extension)

A tree view over the developer-sandbox: every workspace under
`paths.workspaces_root`, its container state, its Telepresence intercepts, and
the `sandbox` CLI lifecycle — without leaving the editor.

A consumer of `packages/sandbox-core`, alongside the `sandbox-dashboard` MCP
server. Unlike the dashboard it imports werkmeister-core directly: the extension host
is plain Node, so there is no HTTP or stdio hop.

## How it works

**Reads** — three werkmeister-core calls, whose cost is flat regardless of workspace count:

| Data | Call |
|---|---|
| Names, paths, issue IDs, labels | `listWorkspaces()` |
| State, slot, ports, per-service health | `getWorkspaceStatuses()` — one `docker ps -a` sweep |
| Per-service intercept state | `getIntercepts()` — one `sandbox status --intercepts --json` |

Polled every 5s **only while the view is visible**.

**Writes** — every mutating command runs the CLI in a `vscode.Terminal` with
`cwd` set to the workspace directory. One terminal per directory, named
`sandbox <workspace>` and reused once its previous command has ended. The extension never spawns
`sandbox` itself except for `sandbox open`, which blocks for the lifetime of the
browser window it launches.

## Configuration

Normally none: werkmeister-core resolves paths from `SANDBOX_*` env vars and falls back
to `~/.sandbox/config.yaml`, which `sandbox config` maintains.

| Setting | Use when |
|---|---|
| `sandbox.binPath` | You have a non-standard checkout and want to name the `sandbox` wrapper directly |
| `sandbox.root` | Same, but naming the checkout directory that contains it |

## Tests

```bash
npm test              # pure logic + the package.json menu clauses, ~100ms, no VS Code
npm run test:integration   # a real extension host (downloads a VS Code build on first run)
```

`src/menus.test.mjs` feeds real `buildTree` nodes into the real `when` clauses
from `package.json`, which is the one place the two can drift apart silently.
The integration suite covers what only a host can answer — command registration
and terminal naming. What neither can reach is in [MANUAL-CHECKLIST.md](https://github.com/jbbz-sandbox/werkmeister/blob/main/packages/vscode-plugin/MANUAL-CHECKLIST.md).

## Install

`sandbox setup` installs it (section 8): the published CLI package ships the
`.vsix`, at the CLI's version. A CLI run from a checkout (`./sandbox` or
`npm link -w apps/cli`) has no `.vsix`, so `setup` skips it. Build and install
it yourself from this directory:

```bash
npm run build && npm run package -- --out sandbox-workspaces.vsix
code --install-extension sandbox-workspaces.vsix --force
```

`--force` replaces an installed copy, even one at the same version. Reload
VS Code windows to pick it up.

## Not included

Repos + PR state, a status bar item, the Claude session `waiting` signal, a
shared-infra node, and token usage — all available in werkmeister-core payload and
additive later.
