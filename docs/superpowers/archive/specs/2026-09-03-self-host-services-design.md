# Self-hosting the sandbox repo's apps and packages as sandbox services

**Date:** 2026-09-03
**Status:** approved in chat, implementing

## Goal

Register the five workspaces of `~/repos/sandbox` (`apps/cli`, `apps/claudeck`,
`apps/sandbox-dashboard`, `packages/sandbox-core`, `packages/vscode-plugin`) in
`~/.sandbox/services.yaml` so a feature workspace can carry the sandbox repo
itself, with every service in its own container. The CLI container must be
fully functional: able to run `sandbox up/down/status/workspace` against the
host's Docker daemon and `~/.sandbox` state.

## What already works (no CLI change)

- The compose template emits `ports:` and a healthcheck unconditionally, and
  the healthcheck is `curl … || exit 0`, so a watch-loop container with no
  listener still reads healthy. Port-less services need only a placeholder
  `internal_port`.
- Every native module (`better-sqlite3`, `keytar`, `sharp`, `cpu-features`,
  `@next/swc`, rollup) hoists to the root `node_modules`, so one per-feature
  volume at `/app/node_modules` plus one shared setup service isolates them
  from the macOS host, exactly like `demo-install`.
- `extra_volumes:` already accepts host bind mounts (left side containing `/`)
  and named volumes; setup services already support `startup_script:` mounted
  from `<sandbox_root>/infra/compose/scripts/<name>-startup.sh`.
- Caddy routing is opt-in per service via `feature_router:`; no
  `remote_upstream` is needed because nothing runs in the cluster.

## Design

### Image

`node:22` (Debian) for the setup service and all five apps. The native modules
ship glibc prebuilds only; alpine would compile from source or fail.

### Setup service `sandbox-install`

`npm install && npm run build`, then `startup.sh` downloads pinned static
binaries into a per-feature named volume `tools` mounted at `/opt/sandbox-tools`:
docker CLI, docker compose plugin (under `docker/cli-plugins`), kubectl. Skips
each download when the binary already exists so re-ups are fast. The build step
is required so `sandbox-core/dist` exists before the watchers and servers start.

### Services

| service | path | command | port (internal / offset) | web |
|---|---|---|---|---|
| sandbox-core | packages/sandbox-core | `tsc --watch` | 3999 / 2 | no |
| cli | apps/cli | `npm run watch` (esbuild) | 3998 / 3 | no |
| vscode-plugin | packages/vscode-plugin | `npm run watch` | 3997 / 4 | no |
| sandbox-dashboard | apps/sandbox-dashboard | `npm run dev` | 3001 / 5 | `feature_router` |
| claudeck | apps/claudeck | `node server.js` | 9009 / 6 | `feature_router` |

Offsets 2–6 leave demo-services' 0–1 untouched so a mixed workspace never
collides. All five use `setup_service: sandbox-install` and
`node_modules_volume: node-modules`. `test:` per service runs turbo with the
package filter from the repo root. `claudeck` declares
`secrets: [ANTHROPIC_API_KEY]`.

### Host access (cli, sandbox-dashboard, claudeck)

The three apps that drive the host share one YAML-anchored block:

- Mounts: `/var/run/docker.sock`; `~/.sandbox`, `~/repos`, `~/features`, and
  `~/.kube` at their **identical host paths**. Generated compose files carry
  host bind-mount paths and the daemon is the host's, so the paths must be the
  same on both sides. `~/.kube` is read-only.
- Environment: `HOME=/Users/jayboyer` so `~` expands identically;
  `PATH=/app/apps/cli:/opt/sandbox-tools/bin:<image default>` so `sandbox`
  resolves to the **worktree's** wrapper (the dogfood point);
  `DOCKER_CONFIG=/opt/sandbox-tools/docker` so the compose plugin is found;
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*`
  because the worktrees are owned by the host uid, not root.

The registry loader uses the `yaml` package, which resolves anchors, so the
block is declared once under an `x-host-access:` key and aliased three times.

### Archetypes

Add `node-tool` with `standards: [engineering, testing]` for the three
build-only services. `sandbox-dashboard` and `claudeck` use the existing
`node-web`.

### Repo mapping

`repos.sandbox` lists the five services with `path_mappings` from each
workspace directory.

### Code change

`apps/sandbox-dashboard/main.ts` binds `127.0.0.1`, unreachable through a
published Docker port. It reads `HOST` from the environment, defaulting to the
current loopback bind. The compose `environment:` sets `HOST=0.0.0.0`.

### Out of scope, and why

- **Telepresence intercepts** from inside the container: telepresence needs a
  root daemon on the host. Run `sandbox intercept` from the host.
- **`gh` and `claude` binaries** in the container: used only by
  `sandbox workspace`'s optional Jira/GitHub login and prompt generation.
  Add to `startup.sh` later if a workspace needs them.
- **Cluster reachability** for `kubectl` inside the container is verified in
  the proof step, not assumed; if OrbStack's API is not reachable from a
  container, that is recorded as a limitation and `sandbox connect` stays a
  host command.

## Verification

1. Workspace with `repos: sandbox` and all five services comes up: five app
   containers healthy, setup exited 0.
2. `docker exec <feature>-cli sandbox status` lists the feature; `sandbox status`
   inside matches the host's output.
3. Both UIs answer via Caddy with the `X-Feature` cookie on
   `dashboard.local.sandbox.com` and `claudeck.local.sandbox.com`.
4. Editing a file in `packages/sandbox-core` rebuilds `dist/` in the container.
5. `sandbox setup --check` reports no drift after the cert is regenerated.

## Known hazard to document

`sandbox_root` is machine-global and points at the main checkout. Running
`sandbox config` or `sandbox setup` from a worktree (host or container)
silently repoints it. Add the warning to the users guide next to the existing
known issue.
