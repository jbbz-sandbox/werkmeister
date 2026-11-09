# Configuration

Reference for the registry, ports, config files, generated files, environment variables and paths.

## Services Reference

### Application Services

The registry is `~/.werkmeister/services.yaml`, and it is **generated**: `werkmeister machine setup`
(or `werkmeister registry sync`) merges every `<repo>/.werkmeister/services.yaml` found
under `paths.repos_root`, then applies `~/.werkmeister/services.local.yaml` on top.
Edit a repo's fragment or the local file, never the generated one.
`werkmeister workspace new` and `init-workspace` regenerate it first, so a new workspace
renders the fragments as they are on disk; a hand-written registry is left alone with a warning.
A workspace's `compose.yml` then takes each of its own repos' services from the fragment in that
repo's worktree, merged over the registry, so a branch that changes a service's `command:`, image, setup or
volumes runs that change in its feature containers before merge; other repos' services, and the registry
file, stay as they are. The demo
registry comes from the `demo-services` repo's own fragment (our private example app;
see [Local Kubernetes bootstrap](../README.md#local-kubernetes-bootstrap)):

| Service | Repo | Path in Repo | Type | Internal Port | port_offset | Health Endpoint |
|---|---|---|---|---|---|---|
| backend | demo-services | `apps/backend` | api | 3000 | 0 | /health <!-- docs-check: ignore --> |
| frontend | demo-services | `apps/frontend` | web | 3000 | 1 | / <!-- docs-check: ignore --> |

The columns above are the required keys. `werkmeister feature services` lists whatever is registered.

### Leaving a repo out on this machine

To keep a cloned repo's services out of the registry without deleting its fragment, list
the repo's directory name under `disabled_fragments` in `~/.werkmeister/services.local.yaml`,
then run `werkmeister registry sync`:

```yaml
disabled_fragments: [demo-services, wellness]
```

Sync leaves out that repo's `services`, `setup_services` and `infrastructure`, along with any
entry in `services.local.yaml` that belongs to it (its `repo:` names it, or it patches one of
its services). It prints a `fragment <repo>` line for each repo it skips, and the generated
file's header lists the skipped fragments as `# Disabled:`. `werkmeister registry sync --check`
counts a disabled repo as expected, not as drift. Port allocation still counts a disabled
repo's ports, so turning it back on never collides. To re-enable a repo, delete its name from
the list and sync again.

### Fragments

How to write a repo's fragment, and how its `test:` and `validate:` are used, is on [Registry fragments](registry-fragments.md).

### Infrastructure Services

These always come from k8s and never run locally:

| Service | k8s Forward Port | Internal Port | Namespace |
|---|---|---|---|
| Redis | 9050 | 6379 | default |
| PostgreSQL | 9051 | 5432 | default |

### Setup Services

Before a monorepo's application services can start, setup services install its dependencies and build its shared packages:

| Setup Service | Repo | Monorepo Type | Memory Limit | Purpose |
|---|---|---|---|---|
| _(none)_ | — | — | — | The demo registry defines no setup services. Add them under `setup_services:` in `~/.werkmeister/services.yaml` for monorepos that need a shared install/build step before their services start. |

A feature that uses services from a monorepo gets that monorepo's setup services in its generated Docker Compose file.

### Self-hosting the Werkmeister repo

The four workspaces of this repo (`apps/cli`, `apps/werkmeister-dashboard`,
`packages/werkmeister-core`, `packages/werkmeister-vscode`) can be registered as services so a
feature workspace develops Werkmeister itself, each package in its own container. The
registry shape is the one in [Services Reference](#services-reference);
the pieces that are not obvious from the demo services:

- **One `node:22` image everywhere.** `better-sqlite3`, `keytar`, `sharp` and the
  esbuild/rollup/swc binaries ship glibc prebuilds only; alpine will not load them.
- **cli, library and extension services idle.** Their containers run `sleep infinity`
  under `init: true` with no healthcheck, so they cost almost nothing at rest and stop
  fast; the gate `docker exec`s their tests. `werkmeister feature up --dev` (or
  `WERKMEISTER_DEV=1 docker compose up -d`) runs their `command:` watchers instead. The
  template still publishes a port, so a placeholder `internal_port` keeps their slot.
- **Host access for `cli` and `werkmeister-dashboard`.** Those two drive the host:
  they get `/var/run/docker.sock` plus `~/.werkmeister`, `~/repos`, `~/features` and `~/.kube`
  bind-mounted at their *host* paths, `HOME` set to match, and the docker, compose and
  kubectl binaries from the per-feature `tools` volume that
  `infra/compose/scripts/werkmeister-install-startup.sh` fills. The generated compose files carry
  host bind-mount paths and the daemon is the host's, so the paths must be identical on both
  sides.
- **`werkmeister-install` reinstalls only when the lockfile changes.** It skips
  `pnpm install --frozen-lockfile` (`npm ci` on a branch still on `package-lock.json`) while <!-- docs-check: ignore -->
  the lockfile and Node major version match the stamp in the node_modules volume. It also
  mounts `~/repos` with git's `safe.directory`, so turbo hashes inputs the same way the app
  containers do. Installs are queued host-wide through `~/.werkmeister/locks`, at most
  `WERKMEISTER_INSTALL_SLOTS` (default 2) at a time, and builds run one at a time. The PR
  gate's service starts don't re-run it once it has succeeded for the current lockfile and
  Node major: they start the service with `--no-deps`, and the gate's own `turbo run
  test` builds what it tests. `werkmeister feature up`, with or without `--service`, still
  re-runs it, so a service started after a pull gets a fresh build. To force a reinstall, run
  `werkmeister feature down -v`. After upgrading, run `werkmeister registry` so the new
  command reaches `~/.werkmeister/services.yaml`.
- **Shared build and package caches.** The registry's built-in `turbo` and
  `pnpm-store` caches attach to `werkmeister-install` and the four services because the repo has
  `turbo.json` and `pnpm-lock.yaml`. Each is a shared named volume (`werkmeister-turbo` at
  `/turbo-cache`, `werkmeister-pnpm-store` at `/pnpm-store`), so a commit any workspace has built
  restores in about a second everywhere, including in the gate's `turbo run test` (`--force`
  measures a cold run), and each package version downloads once per machine. Volumes, not
  host dirs: reads over the VM's file share made a warm install about three times slower.
  node_modules is a per-feature volume on another filesystem, so pnpm copies files out of
  the store rather than hard-linking them. `werkmeister feature status` shows each cache's size and
  age. `werkmeister cache prune` deletes turbo entries older than 14 days (turbo also does
  that itself at the start of each run); `werkmeister cache prune pnpm-store --reset` empties
  the store, and the next install refills it. Add `--dry-run` to see what would go first.
  The old `~/.sandbox/cache/turbo`, `~/.sandbox/cache/pnpm-store` and <!-- name-check: ignore -->
  `~/repos/sandbox/.turbo/cache` dirs are no longer written; delete them by hand. `pnpm` <!-- name-check: ignore -->
  itself is corepack's shim in the `tools` volume, with the pnpm build it fetches kept there
  too (`COREPACK_HOME`), so the four services can run `pnpm turbo …` without an install of
  their own.
- **`werkmeister` inside the container is the worktree's own build.** `PATH` puts
  `/app/apps/cli` first. `werkmeister_root` in `~/.werkmeister/config.yaml` still points at the main
  checkout, so templates and `infra/` come from there (see the known issue on machine-global
  `werkmeister_root`). **Never run `werkmeister machine config --write` or `werkmeister machine setup` from a worktree**, on the
  host or in the container: it silently repoints the whole machine.
- **The dashboard binds `HOST`.** It defaults to loopback for the reasons in `main.ts`; the
  registry sets `HOST=0.0.0.0` because the container network is the isolation boundary and
  Docker's published port is the only way in.
- **New hostnames need `/etc/hosts` entries.** The wildcard certificate already covers
  `*.local.werkmeister.io`, but `werkmeister-dashboard.local.werkmeister.io` only resolves after
  `werkmeister machine setup` (run from the main checkout) reconciles `/etc/hosts`, which needs sudo.
  `werkmeister feature up` and `werkmeister infra proxy-reload` warn about any routed host that does
  not resolve to 127.0.0.1 and print the `/etc/hosts` line to add.
  Caddy emits its site block only once a running feature declares the service.
- **Inside the container, `werkmeister feature status` shows every k8s forward as dead** and `kubectl`
  cannot reach OrbStack's API server: both probe `127.0.0.1`, which is the container's own
  loopback. The forwards are fine; read their state from the host. `werkmeister feature up`, `down`,
  `status` (for features) and `workspace` all work from inside. This applies to a container
  running the CLI *directly*. A container that calls the host MCP surface (`apps/werkmeister-mcp`)
  instead is unaffected: `status` runs on the host, so the forward health it reports
  is the real one.
- **Not covered:** the `gh` and `claude` binaries. Telepresence needs a daemon that owns the
  host's routing (or, with `--docker-daemon`, the Docker socket and a kubeconfig), so
  `werkmeister infra intercept` and `werkmeister infra connect` must run on the host, either from a host
  terminal or through the `intercept` and `connect` tools on `apps/werkmeister-mcp`,
  which run host-side with exactly the authority a host terminal has.
- **A container can instead hold no daemon at all.** `apps/werkmeister-mcp` is the host daemon
  (port 3002; kept up by launchd once `werkmeister machine setup` installs it on macOS, else started by
  `werkmeister infra connect`). It exposes every Werkmeister verb over authenticated HTTP, so a container
  needs only `~/repos`, `~/features` and a token: no docker socket, docker
  CLI, kubectl or `werkmeister` binary. It is the only managed web server that binds
  `0.0.0.0`, via a per-app `env` on its `WebApp` entry; never arrange that by exporting
  `HOST` before `werkmeister infra connect`, which would also expose the unauthenticated dashboard.
  Its `mcp_servers.werkmeister` registry entry is deliberately in no archetype, because `.mcp.json` is
  shared with host sessions, where `host.docker.internal` does not resolve. See
  `apps/werkmeister-mcp/README.md`.
- **Wiring a service to drive Werkmeister that way** takes four edits to
  `~/.werkmeister/services.yaml`, and the granularity is the *service*, not the workspace:
  `services:` entries are machine-global, so a fresh workspace does not isolate a change.
  1. A top-level `x-mcp-client:` block **above** `services:` (YAML resolves anchors in
     document order) holding `mounts: &mcp_client_mounts` (`~/repos` and `~/features` at
     identical host paths) and `env: &mcp_client_env` (`HOME` and the `GIT_CONFIG_*`
     `safe.directory` trio). Loaders read seven top-level keys, so `x-`-prefixed ones are
     ignored. No socket, no `~/.werkmeister`, no `~/.kube`, no tools volume: the host server
     holds all of that.
  2. `extra_volumes: *mcp_client_mounts` and `environment: *mcp_client_env` on the service.
  3. An archetype of its own carrying `mcp_servers: [werkmeister]`, worn only by that service.
     Hand-adding `werkmeister` to a workspace's `.mcp.json` does **not** stick: the projection
     prunes any registry-known server the present archetypes don't want, so the next
     `init-workspace` deletes it.
  4. `WERKMEISTER_MCP_TOKEN` in `~/.werkmeister/secrets.env` (copy `~/.werkmeister/mcp-token`) *and*
     `secrets: [WERKMEISTER_MCP_TOKEN]` on the service entry, which routes it through the
     service's own `.env.<service>`. Never put `${WERKMEISTER_MCP_TOKEN}` in the service's `environment:`:
     compose expands it from whichever shell ran it (for the `up` tool, the MCP
     server's own env, where it is unset), and `environment:` beats `env_file:`, so it
     would shadow the real value with an empty string.

  Then `werkmeister workspace init` and `werkmeister feature down <feature> && werkmeister feature up <feature>`. To
  check it, `docker exec` into the container and POST an MCP `initialize` to
  `http://host.docker.internal:3002/mcp` with `Authorization: Bearer $WERKMEISTER_MCP_TOKEN`
  and `Accept: application/json, text/event-stream`, with no `Origin` header (the
  server rejects one with 403). Drive a *different* feature than the container's own: tearing
  down its own feature kills the caller mid-call.

### Running the agent itself in isolation

The four-edits recipe above wires a *compose service* that Werkmeister manages. The
same server also lets you put the whole agent (Claude Code, the editor, your shell)
somewhere isolated from the host, with port 3002 as the only bridge back. Shape 0 is
generated for you; 1–3 are by hand, in order of how much they share with the host.

**What every shape needs.** The server holds the Docker privilege, so the isolated side
needs none of the socket, `kubectl`, `~/.kube`, `~/.werkmeister` or the `werkmeister` binary.
It does need:

- `~/repos` and `~/features` mounted at their **host** paths. A worktree's `.git` is a
  file holding an absolute `gitdir:` pointer into the main checkout's `.git/worktrees/`,
  so a different mount point breaks every git command in the workspace.
- `HOME` matching the host user, and `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=safe.directory`, `GIT_CONFIG_VALUE_0=*`, because the mounts arrive owned by
  a different uid.
- The workspace's own token, `.werkmeister/token`, which `init-workspace` writes, sent as
  `Authorization: Bearer <token>`. The token names the workspace, so no feature header is needed: the daemon lists only
  that workspace's verbs (`up`, `status`, `logs`, `stop`, `down`, …) and refuses any other
  workspace with error code `SCOPE`. It is an identity, not a security boundary: with
  `~/repos` and `~/features` mounted read-write, the agent can already change what the
  host runs. Use `~/.werkmeister/mcp-token`, the machine token, only for host-wide tools.
- A route to the host's 3002: `host.docker.internal` resolving to the host gateway.
- A container-only MCP registration for `http://host.docker.internal:3002/mcp` carrying
  that header, made inside the container. Never put it in the
  workspace's `.mcp.json`: host sessions share that file, and `host.docker.internal` does
  not resolve on the host.

Two things stop working on the isolated side, by design. The `werkmeister` plugin's
MCP entry runs `werkmeister internal mcp` over stdio, and its skills shell out to the CLI; with
no binary there, use the tools the HTTP server exposes instead. And the
dashboard on 3001 is loopback-only and unauthenticated, so it is correctly unreachable.

**0. The generated devcontainer.** On a `harness: claude` workspace, `init-workspace` writes
`<workspace>/.devcontainer/devcontainer.json`; any other harness gets none, and a generated
one left from before is removed, since it runs only Claude Code. The file sets every item
above: `~/features` (as the workspace mount) and `~/repos` bound at their host paths, `HOME` and the
`GIT_CONFIG_*` trio in `containerEnv`, `--add-host host.docker.internal:host-gateway` in
`runArgs`, and a `postCreateCommand` that installs `claude` and runs
`claude mcp add-json --scope user werkmeister` for `http://host.docker.internal:3002/mcp`
with a `headersHelper` that reads the mounted `.werkmeister/token` at every connect, so a
re-minted token needs only a reconnect (`/mcp`), not a rebuild. It is regenerated on every
`init-workspace`; don't edit it. Open the workspace folder in VS Code and pick **Reopen in
Container**, or run `npx @devcontainers/cli up --workspace-folder ~/features/<workspace>`.

`~/.claude` inside is one volume, `werkmeister-claude-home`, shared by every workspace's
container, so you log in to `claude` once. Or skip the login: export a `claude setup-token`
token as `CLAUDE_CODE_OAUTH_TOKEN` on the host before the container is created; the
devcontainer reads it at every attach (`remoteEnv`), so no generated file or container holds it
and a new token needs only a reopen.
Each container still reaches only its own workspace: the registration lives in
`~/.claude.json`, outside the volume, is made again on every create, and sends that
workspace's token. Close-out, abandon and `clean` never remove the volume; to reset the
shared login, `docker volume rm werkmeister-claude-home` with no devcontainer running.
The volume holds no plugins,
so only the HTTP server's tools appear. Check it with `claude mcp list` inside: it should
show `werkmeister` as connected.

**1. A plain container, by hand.** Nothing Werkmeister-managed; the host only needs
the daemon up (`werkmeister machine setup` on macOS, else `werkmeister infra connect`).

```bash
docker run -it --rm \
  -v "$HOME/repos:$HOME/repos" -v "$HOME/features:$HOME/features" \
  -e HOME="$HOME" \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  -e WERKMEISTER_MCP_TOKEN="$(cat ~/features/my-feature/.werkmeister/token)" \
  --add-host host.docker.internal:host-gateway \
  -w "$HOME/features/my-feature" node:22 bash
```

Use `node:22`, not alpine, for the reason in the self-hosting list. Install `claude`
inside as you would anywhere. The smoke test is the same `initialize` POST as above.

**2. Docker Sandboxes (`docker sandbox run claude …`) or any other microVM agent runner.** <!-- name-check: ignore -->
Structurally it is shape 1 with a stronger wall: the agent runs in a VM with **its own
Docker daemon**, so even a socket mount would show it an empty engine, never the host's
compose containers. Port 3002 is the only way to drive Werkmeister from inside. Two
things to check against whatever product you use, since they vary and are not verified
here: that its network policy lets the VM reach the host gateway (the server refuses
nothing but a browser `Origin`, so an allow-rule for `host.docker.internal:3002` is all
it needs), and that it can mount `~/repos` *and* `~/features` at host paths rather than
only the directory you launched it from. `docker sandbox` is a Docker Desktop feature; <!-- name-check: ignore -->
on a machine whose Docker context is OrbStack or Colima it doesn't exist.

**3. A full VM with its own stack.** An OrbStack Linux machine, Lima, or a cloud box
running `werkmeister machine setup` end to end: its own `dockerd`, Caddy, `k8s-forwards` and
telepresence, with the only shared thing a kubeconfig. The compose files already map
`host.docker.internal:host-gateway`, so plain Linux `dockerd` works unchanged. This is
the one shape that isolates you from the host's *containers* as well as its daemon, and
it is a second complete install: `~/.werkmeister`, certificates, `/etc/hosts` and all. To use
the host's browser against it, point the host's `*.local.werkmeister.io` entries at the VM's
address instead of loopback, and copy the VM's CA into the browser's trust store. The
apps/werkmeister-mcp server isn't used here: the CLI runs natively inside.

Pick 1 when you want the agent off the host's Docker socket and nothing more. Pick 2
when the runner is already part of your workflow. Pick 3 only when a wrong `werkmeister
clean` or a runaway compose build must not be able to touch the host's engine at all.

## Port Allocation

### Feature Slot Ports

Each slot gets a range of 20 ports within a 100-port block:

```
Slot N: base = 11100 + (N-1) * 100
        range = base .. base+19
```

| Slot | Base Port | Range |
|---|---|---|
| 1 | 11100 | 11100–11119 |
| 2 | 11200 | 11200–11219 |
| 3 | 11300 | 11300–11319 |
| 4 | 11400 | 11400–11419 |
| 5 | 11500 | 11500–11519 |
| 6 | 11600 | 11600–11619 |
| 7 | 11700 | 11700–11719 |
| 8 | 11800 | 11800–11819 |
| 9 | 11900 | 11900–11919 |
| 10 | 12000 | 12000–12019 |
| 11 | 12100 | 12100–12119 |
| 12 | 12200 | 12200–12219 |

A service's specific host port = `base_port + port_offset`. For example, `frontend` (offset 1) in slot 3 = `11300 + 1 = 11301`.

The 80-port gap between each slot's 20-port range is reserved for future expansion.

### k8s Forward Ports

Fixed ports shared by all features:

| Port | Service | k8s Namespace | Remote Port |
|---|---|---|---|
| 9050 | redis | default | 6379 |
| 9051 | postgres | default | 5432 |
| 9052 | backend | default | 80 |
| 9053 | frontend | default | 8080 |

## Configuration Files

Machine config lives in `~/.werkmeister`, each workspace's generated state in `<workspace>/.werkmeister/`, and a repo's registry fragment in `<repo>/.werkmeister/services.yaml`. `~/.sandbox` and `.sandbox/` are the pre-rename names, and nothing reads them any more: the CLI stops and asks you to migrate when it finds `~/.sandbox` without `~/.werkmeister`. <!-- name-check: ignore -->

To move a machine off `~/.sandbox`, stop its workspaces and the shared infra, then run `werkmeister machine migrate` once. It moves `~/.sandbox` to `~/.werkmeister` and repoints every file that carries the old path: `config.yaml`, `env.sh`, the `~/.zshenv` block, `services.yaml`, the pr-watch schedule and each workspace's compose file. It refuses while a container the move would break is running, and a second run changes nothing. `--workspaces` also renames each workspace's `.sandbox/` to `.werkmeister/`; run `werkmeister workspace init` in each one afterwards so its generated text follows. `--check` reports what would change without writing. Pull and rebuild the CLI before you migrate: a CLI built before the move skips `.werkmeister/` fragments. <!-- name-check: ignore -->

### ~/.werkmeister/services.yaml (generated)

The central service registry: every service, with its repo, path, ports, k8s details and dependencies.

Generated by `werkmeister registry sync` from every `<repo>/.werkmeister/services.yaml`
(see "Writing a fragment"); `archetypes:` and `mcp_servers:` come from Werkmeister's
own defaults, `repos:` is derived, and `~/.werkmeister/services.local.yaml` is merged last.

**Top-level keys:**

- **`services`**: Map of service name to service definition. Each service has:
  - `repo` (string | omitted): Repository name (directory name in workspace). Omit it, and set `image`, for an image-only service
  - `image` (string): Container image, default `node:22`. With no `repo` the service is **image-only**: no repo mount, no build, and the image's own CMD unless `command` is set (run with `/bin/sh -c`). Useful for a stock container such as `nginx:alpine` in a fixture workspace. Declare it in the machine `services.yaml` (or its overrides), not in a repo fragment, which always ties a service to its repo:

    ```yaml
    services:
      web:
        image: nginx:alpine
        internal_port: 80
        port_offset: 0
        command: nginx -g 'daemon off;'   # optional
    ```
  - `path` (string): Path within the repo (`.` for entire repo, `apps/frontend` for monorepo packages) <!-- docs-check: ignore -->
  - `type` (string): Service category: `web`, `api`, `graphql-subgraph` (also `graphql`, `subgraph`, `federation`), `graphql-gateway`
  - `internal_port` (int): Port the service listens on inside its container
  - `port_offset` (int): Offset within the feature slot range (0–19)
  - `k8s_deployment` (string | null): Kubernetes deployment name
  - `k8s_namespace` (string | null): Kubernetes namespace
  - `k8s_port` (int | null): Port the k8s pod listens on
  - `k8s_pod_prefix` (string | null): Pod name prefix for kubectl
  - `health_endpoint` (string): HTTP path for health checks
  - `monorepo` (string | null): `turbo` or `nx` if part of a monorepo
  - `setup_service` (string | null): Required setup service name
  - `memory_limit` (string): Docker memory limit (e.g., `2G`, `2560M`)
  - `memory_reservation` (string): Docker memory reservation
  - `environment` (map | null): Additional env vars for the service
  - `command` (string | null): Custom startup command
  - `depends_on` (list | null): Service dependencies
  - `extra_services` (map | null): Sidecar containers (e.g., Redis instances)
  - `dockerfile` (string | null): Dockerfile in the service's `path`, built into the service's image and tagged `image:` (a local tag, never pulled)
  - `node_modules_volume` (bool): Whether to use a named volume for node_modules
  - `extra_volumes` (list | null): Additional volume mounts: a host path (`${REPO}/.git:/app/.git:ro`), a bare name for a per-feature named volume (`turbo-cache:/app/.turbo`, created as `<feature>-turbo-cache`), or `^name` for one volume every feature shares (`^werkmeister-pnpm-store:/pnpm-store`). A shared volume is created on `werkmeister feature up` and declared `external`, so no feature's `down --volumes`, close-out or `clean` removes it; drop it by hand with `docker volume rm <name>`
  - `caches` (list | null): Keys in the registry's `caches:`. Unset, a service gets its archetype's `caches` plus every cache whose `detect` file is in its directory or a parent up to its repo root; a list replaces both, and `[]` opts out

- **`infrastructure`**: Infrastructure services (redis, postgres) with k8s forward ports
- **`setup_services`**: Optional per-monorepo install/build steps that run before a repo's services start
- **`caches`**: Build and package caches shared by every workspace, keyed by name. Each has a container `path`, the `env` that points the tool at it, the `detect` files (e.g. `yarn.lock`) that attach it, and at most one of `max_age` (`<N>d`, used by `werkmeister cache prune`) or `prune` (a command run in a throwaway container, `image:` default `node:22`). It lives in the shared volume `werkmeister-<key>` (or `volume:`), or in a host dir with `host:`. `turbo` and `pnpm-store` are built in; a repo's fragment may add caches but not redefine those. Example: `yarn-cache: {path: /yarn-cache, env: {YARN_CACHE_FOLDER: /yarn-cache}, detect: [yarn.lock], max_age: 30d}`
- **`repos`**: Repo-to-service mapping with `path_mappings` for monorepos

### ~/.werkmeister/ports.yaml

Port allocation scheme:

```yaml
feature_slots:
  count: 12          # Feature slots (default 12; raise it)
  base_port: 11100   # Starting port for slot 1
  ports_per_slot: 20  # Ports available per slot
```

(k8s forward listen-ports live per-service in `services.yaml` as
`k8s_forward_port:`, the single source of truth for the forward table.)

### k8s forward table (in services.yaml)

The k8s port-forward table is not a separate file: each forwarded service in
`services.yaml` carries its forward fields inline:

```yaml
services:
  backend:
    k8s_forward_port: 9052   # Host/container listen-port (the 9000-range)
    k8s_port: 80             # Port on the k8s Service (remote)
    k8s_namespace: default
    k8s_pod_prefix: backend
    health_endpoint: /health
  frontend:
    k8s_forward_port: 9053
    k8s_port: 8080
    k8s_namespace: default
    k8s_pod_prefix: frontend
    health_endpoint: /
infrastructure:
  postgres:
    k8s_forward_port: 9051   # no health_endpoint → TCP-only health check
```

A service whose forward/alias name differs from its service key can set
`k8s_forward_name:` to override it.

Both runtime consumers of this table are **generated** from `services.yaml` by
`werkmeister infra connect` (`packages/werkmeister-core/src/k8s_forwards.ts`) under `~/.werkmeister/infra/`:
the container's forward list is written to `k8s-port-forward/forwards` (mounted at
`/tmp/forwards`, read by `entrypoint.sh`), and the `k8s-forwards` service's
`ports:`/`aliases:` are written to `compose/k8s-forwards.override.yml`, which every
`docker compose` call the CLI makes passes as a second `-f`. The shipped
`shared-infra.yml` is never modified.
The "shipped shared-infra.yml" tests in `apps/cli/src/lib/__tests__/k8s_forwards.test.ts` fail if the committed
`shared-infra.yml` drifts out of sync. To add or change a forward, edit only
`services.yaml` and run `werkmeister infra connect`.

### ~/.werkmeister/config.yaml: models

Which model a workspace runs is werkmeister's choice, by tier, never the harness's own default. `--model` on `workspace new` / `workspace init` takes a tier (`small`, `mid`, `frontier`, `advanced_frontier`) or an explicit model (an alias or full id); blank means `models.default_tier`. The tier resolves once, at create or init, and the resolved model is written to `.werkmeister/workspace.yml` and `.claude/settings.json`, so changing this block affects new workspaces only.

```yaml
models:
  default_tier: frontier        # optional; built-in frontier
  claude:                       # one block per harness id: claude, opencode, codex
    mid: claude-sonnet-5-5      # overrides one tier; the others keep the built-in
  codex:
    frontier: <an OpenAI model id>
```

Built-ins, used for every tier the block leaves out:

| harness | small | mid | frontier | advanced_frontier |
|---|---|---|---|---|
| claude | haiku | sonnet | opus | claude-fable-5-1 |
| opencode | anthropic/claude-haiku-5-5 | anthropic/claude-sonnet-5-5 | anthropic/claude-opus-5-5 | anthropic/claude-fable-5-1 |
| codex | — | — | — | — |

A tier with no model for the workspace's harness fails create, and init of a workspace that records no model yet, with the key to set (`models.codex.frontier`). The generic `mcp` harness takes no model, so its workspaces are not resolved. `werkmeister machine config` prints the merged tiers, each set value marked `(YAML)`. Workspaces created before this record no model: `werkmeister machine migrate` (or each one's next `workspace init`) writes the default tier's model and names it.

### Optional integrations

None of these are required; each turns on only when configured.

#### Issue tracker

`werkmeister machine setup` asks which tracker this machine uses, `jira` (the default) or `github`,
and stores it as `overrides.issue_tracker` in `~/.werkmeister/config.yaml`. With `github`, a
workspace's issue ID is `owner/repo#n` and issues are filed in the registry repos under
`overrides.github_org`.

Issues about Werkmeister itself go to GitHub (`jbbz-sandbox/werkmeister`) unless, under
`jira`, `overrides.werkmeister_issues_project` names a Jira project (e.g. `SW`): the generated
issues guide then sends them there with `werkmeister issue create`.

For Jira, set `jira.base_url` (e.g. `https://your-org.atlassian.net`) to get issue links in
CLAUDE.md, the dashboard, and VS Code. Briefings fetched through the Atlassian MCP use
`jira.cloud_id` when set, otherwise the `base_url` hostname. The REST token is optional. For
each tracker's setup (the Jira token, GitHub's `gh auth`), see [Issue trackers](issue-trackers.md).

Read or update an issue in the configured tracker from the command line:

```bash
werkmeister issue view [ref] [--json]                                # print the issue (--json: as JSON)
werkmeister issue update [ref] --status <name> --comment <text>      # either option alone works too
werkmeister issue create --project <KEY> --type bug|feature|task --title <text> --body-file <path|->  # Jira: file one, print its URL
```

`create` needs the Jira REST token and maps `bug`/`feature`/`task` to Bug/Story/Task; a project
without that type gets a Task labelled with it. Write the body and `--comment` in Markdown: headings,
lists, bold, code spans, fenced blocks and links are converted to Jira wiki markup on the way in.
GitHub issues are filed with `gh issue create`.

`ref` is optional inside a workspace, where it defaults to the workspace's `issue_id`. On GitHub,
`--status closed` or `done` closes the issue, `open` reopens it, and any other status is added
as a label.

#### Projects

A machine with one tracker needs nothing below. When you work on products that track their
work in different places (one in Jira, one in GitHub issues), give each a project in
`~/.werkmeister/config.yaml`. A project is a tracking strategy: a tracker with its scope, and
optionally a board and its own status names. It holds no repos or services.

```yaml
projects:
  werkmeister:
    tracker: { id: jira, project: SW }               # tracking software: Jira, project key SW
    board: { id: 42, ready: Selected for Development }   # optional: a board in that tracker
    issue_statuses: { in_review: In Review }         # optional: replaces overrides.issue_statuses
    default: true                                    # optional: at most one project
  acme:
    tracker: { id: github, org: acme, repos: [acme/web, acme/api] }   # repos optional
    board: { id: 3, ready: Ready }                   # a GitHub Projects number owned by org
```

Names are lowercase letters, digits and single hyphens.

**The two tracking strategies.**

- **Tracking software** is the `tracker`. Jira needs `project` (the key); the site and token stay
  the one `jira:` block above, shared by every Jira project. GitHub needs `org`; `repos` narrows
  the scope to those repos, else it is every registry repo under `org`.
- **A board** inside that tracker decides what is ready and in what order: `ready` names the column
  whose items are ready to start, and the board's own rank orders them. There is no default
  column. The board only reads order: status moves still use `issue_statuses`.

**Which tracker a workspace uses.** A workspace records its project as `project:` in
`workspace.yml`, and its issue link, status moves and `pr open` / ship updates go to that
project's tracker with that project's status names. A project's `issue_statuses` start from its
tracker's defaults, not from `overrides.issue_statuses`. An issue ref with no workspace (a PR
body, the dashboard's issue column) goes to the project whose scope holds it. A workspace with no
`project:`, and every workspace on a machine with no `projects:`, uses `overrides.issue_tracker`
exactly as above.

**Creating a workspace.** `werkmeister workspace new --issue-id <ref> [--project <name>]`; the create
form and the wizard ask for the project after the issue. Left blank, it is the project whose
scope holds the ref, else the `default: true` one; a ref that fits none fails and lists the
projects. The ref is then checked with that project's tracker.

**What is ready next.** `werkmeister issue ready [--project <name>] [--json]` lists a project's
open work in priority order. With a board, it is the board's `ready` column in board rank; without
one, the scope's open issues (Jira: `statusCategory != Done` by priority then rank; GitHub: each
scoped repo's open issues, oldest first). The project is `--project`, else the workspace's, else
the `default: true` one, else the only one. The `next-wave` plugin skill reads its tickets from it.
Jira needs the REST token (`jira.api_token`, [Issue trackers § Jira](issue-trackers.md#jira-api-token)). A GitHub board
needs the `read:project` token scope: `gh auth refresh -s read:project`. One page is read: 100
issues on Jira, 200 board items on GitHub.

`werkmeister machine config --check` names each invalid project; an invalid project is skipped with a
warning. `werkmeister infra connect` checks sign-in for each project's tracker.

**Adding a second tracker.** `werkmeister machine setup` and `werkmeister machine config` never ask about
projects; when they rewrite `config.yaml` they keep the `projects:` section you wrote. So:

1. Run `werkmeister machine setup` as usual. The tracker it asks for stays the one every workspace
   without a project uses.
2. Add the `projects:` block to `~/.werkmeister/config.yaml` by hand (example above). For a Jira
   project, the `jira:` credentials from setup are the ones it uses.
3. `werkmeister machine config --check` to validate it.
4. `werkmeister infra connect` to check sign-in for each project's tracker.

#### Slack review requests

The dashboard's "Request review" button posts to Slack. Set both
`WERKMEISTER_REVIEW_SLACK_TOKEN` (a bot token with `chat:write`) and
`WERKMEISTER_REVIEW_SLACK_CHANNEL` (the channel id). Without them the button reports that Slack
is not configured.

#### GraphQL federation

When a service in the registry has a GraphQL type (`graphql-subgraph`, `graphql`, `subgraph`,
`federation`), `werkmeister feature up` writes
`<workspace>/.werkmeister/supergraph-config.yml` listing each subgraph's URL for your gateway.
Registries without a subgraph get no file.

## Generated Files

When you run `werkmeister feature up <feature>`, `compose.yml` and `.env` are generated at the feature's workspace root, plus `supergraph-config.yml` under `<workspace>/.werkmeister/` when the registry has a GraphQL subgraph:

### compose.yml

Workspaces generated before this name (`docker-compose.yml`) are renamed on the next `werkmeister workspace init` or `werkmeister feature up`; until then `down`, `logs` and `close-out` still read the old name. The running stack is unaffected, because Compose keys it by the file's `name:`, not its path.

Per-feature Docker Compose stack containing:
- **Network**: An isolated bridge network named `werkmeister-<feature>`
- **Setup services** (if needed): Node.js containers that install monorepo dependencies before application services start
- **Application services**: One container per local service with:
  - Source code mounted from the workspace
  - Port mapping from the feature's slot range to the service's internal port
  - Environment variables with resolved URLs for all services (Docker DNS names for local services, `k8s-forwards:9xxx` for k8s services)
  - Memory limits from `services.yaml`
  - Health checks using `curl` to the service's health endpoint
  - `depends_on` the setup service (with `service_healthy` condition)
- **Networks**: Feature containers join both the feature-specific network (`werkmeister-<feature>`) and the `werkmeister-shared` network, enabling communication with shared infrastructure (k8s-forwards, caddy, and jaeger / redisinsight when enabled)

### .env

Environment file loaded by Docker Compose, containing:
- `SANDBOX_FEATURE`, `WERKMEISTER_SLOT`, `COMPOSE_PROJECT_NAME`
- Node.js version and environment settings
- Resolved URLs for every service (e.g., `FRONTEND_URL=http://frontend:3000`)
- Database connection strings pointing to shared infrastructure (e.g., `REDIS_URL=redis://redis:6379`)

### supergraph-config.yml

Optional: generated only when a service has a GraphQL type (`graphql-subgraph`, `graphql`, `subgraph`, `federation`). It lists each subgraph's URL for an Apollo-compatible gateway; local services point to slot ports and remote services to k8s forwards.

## Environment Variables

| Variable | Used By | Default | Purpose |
|---|---|---|---|
| `WERKMEISTER_ROOT` | CLI, all commands | Auto-detected from script location | Root path of the Werkmeister repository. Set from `~/.zshenv` (not `~/.zshrc`) so non-interactive shells (Claude Code's Bash tool, cron, MCP servers) can see it. |
| `WERKMEISTER_DEBUG` | CLI dispatcher | (not set) | When set to any value, print full stack traces on errors |
| `WERKMEISTER_WORKSPACES_ROOT` | config, detect | `~/workspace` | Root directory containing feature workspaces. Set from `~/.zshenv` (not `~/.zshrc`) for the same non-interactive-shell reason as `WERKMEISTER_ROOT` above. Deprecated aliases (kept for back-compat, removed in v2): `WERKMEISTER_WORKSPACE_ROOT` (singular form), `WORKSPACE` (legacy), `VIBE_WORKSPACES_ROOT` (pre-VK-decoupling). |
| `SANDBOX_FEATURE` | test command, .env | (not set) | Set in the environment of Playwright test processes |
| `WERKMEISTER_SLOT` | test command, .env | (not set) | Set in the environment of Playwright test processes |
| `GITHUB_AUTH_TOKEN` | .env, containers | (required) | GitHub token for npm registry access |
| `POSTGRES_INSTANCE` | .env | (required) | Cloud SQL Proxy instance connection string |

## File Paths Reference

### Werkmeister Repository

| Path | Description |
|---|---|
| `apps/cli/werkmeister` | Launcher: resolves a node runtime and execs `dist/main.js`. |
| `apps/cli/src/main.ts` | CLI dispatcher |
| `apps/cli/src/commands/` | Command modules (up, down, status, etc.) |
| `apps/cli/src/lib/` | CLI-only helpers (config, gate, PR guard, wizard); the shared engine (detect, slots, generate, docker, k8s, caddy) is in `packages/werkmeister-core/src/` |
| `~/.werkmeister/services.yaml` | Service registry (generated by `werkmeister registry sync`) |
| `~/.werkmeister/ports.yaml` | Port allocation scheme |
| `apps/cli/infra/compose/` | Shared-infra compose file, the k8s-port-forward image, redisinsight config, container scripts |
| `apps/cli/infra/compose/k8s-port-forward/` | Dockerfile and entrypoint for containerized k8s port-forwards |
| `apps/cli/infra/templates/` | nunjucks templates for per-feature file generation |
| `apps/cli/infra/compose/shared-infra.yml` | Shared infrastructure (k8s-forwards, caddy; opt-in jaeger, redisinsight) |
| `~/.werkmeister/infra/proxy/Caddyfile` | Generated Caddy config (never inside the package) |
| `apps/cli/infra/proxy/ui/index.html` | Feature selector web UI |
| `apps/cli/bin/` / `bin/` | Setup helper scripts (`generate-certs.sh`; `setup-telepresence-cluster.sh`) |
| `apps/cli/dist/` | Compiled CLI (esbuild bundle; `apps/cli/werkmeister` execs `dist/main.js`, gitignored) |
| `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` | Workspace metadata, the workspace globs and the pinned dependency lock (pnpm workspaces, root-level) |

### User Home Directory

| Path | Description |
|---|---|
| `~/.werkmeister/slots.json` | Active slot assignments for all features |
| `~/workspace/<feature>/` | Feature workspace containing repo worktrees |
