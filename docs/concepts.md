# Concepts

How Werkmeister runs many features at once: what a feature and a workspace are, and how slots, the proxy and the baseline fit together. To get going first, see the [Quick Start](quick-start.md).

## Overview

Werkmeister is a CLI that runs many features at once on one machine. Instead of running every service locally, each feature runs **only the services with code changes** in Docker containers. Everything else comes from a baseline: a k8s cluster through containerized `kubectl port-forward` processes, a remote host, or nothing ([Without Kubernetes](topology.md#without-kubernetes)).

A Caddy reverse proxy terminates HTTPS, serves the feature selector UI, and routes each service's public hostname directly. It reads an `X-Feature` cookie or header from incoming requests and routes them to the correct feature's local containers — or falls back to the baseline for services that aren't running locally.

**Key benefits:**

- **Low memory footprint** — a local service costs about half a gigabyte, so a feature running two or three of them is a fraction of the full stack
- **Feature isolation** — each feature gets its own Docker network, port range, and compose stack; no cross-contamination
- **Auto-detection** — `werkmeister feature up` analyzes your git changes to determine which services to run
- **Many features at once** — a feature costs only the services it runs locally, so how many fit depends on the memory you give the container manager. The default is 12 slots (`feature_slots.count`), and you can raise it.

## Cluster Access

The k8s port-forwards need a working kubectl context. Werkmeister's default is the
local OrbStack cluster, named by the top-level `k8s_context` key in
`~/.werkmeister/services.yaml` (e.g. `k8s_context: orbstack`).

```bash
kubectl config get-contexts        # list available contexts
kubectl config current-context     # confirm the active one
kubectl get nodes                  # confirm the cluster answers
```

Authentication is whatever your kubeconfig already carries — OrbStack embeds a
client cert, so no cloud-provider CLI or auth plugin is required. If you point
`k8s_context` at a remote cluster, set that context up with your provider's own
tooling first; Werkmeister only reads the resulting kubeconfig.

## Workspace Directory

Werkmeister supports two workspace layouts:

**Standalone layout** (default) — repos checked out flat in `~/workspace/`:

```
~/workspace/
└── werkmeister/        # standard git clone
```

Feature names are arbitrary labels (not directory names). Override the default path with `--workspace` or the `WORKSPACE` env var.

**Multi-feature layout** — per-feature workspace nesting (one parent dir, one subdir per feature, repo worktrees under each). Activated by setting `WERKMEISTER_WORKSPACES_ROOT` and laying out subdirectories like:

```
~/workspace/         # set WERKMEISTER_WORKSPACES_ROOT to this
├── feature-abc/
│   └── werkmeister/    # git worktree of the werkmeister repo
├── feature-xyz/
│   └── werkmeister/
└── ...
```

In this layout each feature maps to a subdirectory containing its repo worktrees. This layout is what Vibe Kanban's automation produces by default, but Werkmeister itself is layout-agnostic — any directory with worktrees under `WERKMEISTER_WORKSPACES_ROOT/<feature>/` works.

## Features & Workspaces

A **feature** is a named unit of development work. The feature name is an arbitrary label used for slot allocation, container naming, and proxy routing.

By default, Werkmeister looks for repos in `~/workspace/`. Override with `--workspace`, the legacy `WORKSPACE` env var, or `WERKMEISTER_WORKSPACES_ROOT` (preferred) for per-feature workspace nesting.

**Resolution priority** (see `resolve_workspace` in `apps/cli/src/lib/config.ts`):
1. `--workspace` flag (explicit path)
2. `WERKMEISTER_WORKSPACES_ROOT` env var (preferred)
3. `WERKMEISTER_WORKSPACE_ROOT` env var (deprecated alias — removed in v2)
4. `WORKSPACE` env var (legacy alias, kept for back-compat)
5. Auto-detect from the current directory — walk up to the nearest `.git` boundary and use its parent, so you can run `werkmeister` from inside a repo/worktree
6. `~/workspace/` (fallback)

When you run `werkmeister feature up my-feature`, the CLI:
1. Resolves the workspace directory (default: `~/workspace/`, or per the priority above)
2. Reads the `SERVICES=` list from the workspace's `.env` (written by `init-workspace`)
3. Looks each one up in `~/.werkmeister/services.yaml`
4. Starts only those services locally

## Initializing a Workspace

`werkmeister workspace init` writes the per-feature `CLAUDE.md` and `.env` into the workspace root. Each input resolves in this order (first non-empty wins):

1. **CLI flag** — `--feature`, `--services`, `--issue-id`, `--test-path`, `--description`, `--task`
2. **`WERKMEISTER_*` env var** — `WERKMEISTER_SERVICES`, `WERKMEISTER_ISSUE_ID`, `WERKMEISTER_TEST_PATH`, `WERKMEISTER_DESCRIPTION`, `WERKMEISTER_TASK`. `WERKMEISTER_FEATURE` is not an input: every workspace container exports it as its own feature name, and `SANDBOX_FEATURE` alongside it for the transition. <!-- name-check: ignore -->
3. **Config file** — `<workspace>/.werkmeister/workspace.yml` (override with `--config <path>` or `WERKMEISTER_WORKSPACE_CONFIG`; legacy `workspace.jsonc` / `workspace.json` are still read)
4. **Stdin / defaults** — piped stdin or a slug-derived hint from the workspace directory name (for `task`)

```bash
werkmeister workspace init \
    --feature blog \
    --services frontend,backend \
    --issue-id <ref>
```

`<ref>` is an issue ID in the tracker `werkmeister machine setup` picked; it is stored as `issue_id` in
`.werkmeister/workspace.yml`.

## Slots & Port Ranges

Each active feature is assigned a **slot** (numbered 1 to `feature_slots.count`, default 12). The slot determines the feature's 20-port host range, and a service's host port is that range's base plus its `port_offset` from `~/.werkmeister/services.yaml`. The table and formula are in [Port Allocation](configuration.md#port-allocation).

The slot is recorded as the `com.werkmeister.slot` label on the feature's containers, so it survives terminal restarts.

## k8s Port-Forwards (Baseline)

All services are available from k8s on a fixed port range (9000–9099), shared across all features. These are the "baseline" — when a feature doesn't run a service locally, requests are routed to the k8s forward.

k8s port-forwards now run inside a Docker container (`k8s-forwards`) as part of shared infrastructure (`apps/cli/infra/compose/shared-infra.yml`). They are accessible via the Docker DNS name `k8s-forwards` on the `werkmeister-shared` network. The port table is in [k8s Forward Ports](configuration.md#k8s-forward-ports).

These ports are internal to the Docker network — other containers reach them via `k8s-forwards:9xxx`. k8s forwards must be running before starting features. Start them with `werkmeister infra connect`.

## Caddy Reverse Proxy

Caddy runs as a Docker container (ports 80 and 443) and provides:

1. **HTTPS termination** — Caddy terminates HTTPS on port 443 using locally-trusted certificates
2. **Feature selector UI** — a web page at `https://frontend.local.werkmeister.io/__werkmeister` for setting the active feature in your browser
3. **Feature resolution** — Caddy matches the `X-Feature` cookie and reverse-proxies to that feature's local container, falling back to the k8s baseline when the service isn't running locally
4. **Per-service hostnames** — each routed service gets its own hostname derived from `ingress.local_domain` (e.g., `frontend.local.werkmeister.io`)

The base domains default to `local.werkmeister.io` and `remote.werkmeister.io`. `werkmeister machine setup` writes them into `~/.werkmeister/config.yaml`, so a machine set up before the defaults moved off `local.sandbox.com` keeps its domains, certificate and `/etc/hosts` entries. To move one, change the domains in the `werkmeister machine setup` wizard; it regenerates the certificate and hosts entries for them. <!-- name-check: ignore -->

The Caddyfile is regenerated automatically whenever you run `werkmeister feature up`, `werkmeister feature down`, `werkmeister feature drop`, or `werkmeister infra proxy-reload`.

## Which services run locally

`werkmeister feature up` runs the services listed in the workspace's `.werkmeister/workspace.yml` `services:` key (or passed with `-s`). Everything else is reached in the cluster through the k8s-forwards tunnels.

## Concurrency & Isolation

Each feature runs in an isolated environment:

- **Docker networks** — each feature gets its own bridge network (`werkmeister-<feature>`)
- **Container names** — prefixed with the feature name (`<feature>-<service>`)
- **Named volumes** — `node_modules`, build caches, and other named volumes are prefixed with the feature name (e.g., `my-feature-frontend_node_modules`) so concurrent features never share mutable state
- **Port ranges** — each feature's slot maps to a dedicated host port range (see [Slots & Port Ranges](#slots--port-ranges))
- **Generated files** — each feature's `compose.yml` and `.env` are written to its workspace root, and, when the registry has a GraphQL subgraph, `supergraph-config.yml` to `<workspace>/.werkmeister/`

**Single-repo concurrency note:** In single-repo mode (`~/workspace/` with one checkout per repo), all features share the same source code checkout. This means two features modifying the same repo will see each other's uncommitted changes. For true concurrent multi-feature development, use the per-feature workspace layout via `WERKMEISTER_WORKSPACES_ROOT=<parent>` and place git worktrees under each feature subdir.

## Optional shared infrastructure

Jaeger and RedisInsight are opt-in. To start either or both with the shared infrastructure, add their profiles to `~/.werkmeister/config.yaml` and run `werkmeister infra connect` again:

```yaml
infra:
  profiles: [redisinsight, jaeger]
```

For a one-off, `COMPOSE_PROFILES=redisinsight werkmeister connect`. `werkmeister infra down` removes them either way.

No cluster? `infra.baseline` runs the base services you aren't changing from digest-pinned images, and each service's `baseline_upstream` in `services.yaml` points `{service}` references at them. See [Without Kubernetes](topology.md#without-kubernetes).

## Creating a workspace

Every entry point — `werkmeister workspace new`, `--browser-form`, the MCP `workspace` /
`create-workspace` tools, and the /workspaces pane — runs the same `createWorkspace`.
With an issue ID it fetches the issue (failing if it can't), stores it in
`.werkmeister/issue.md`, fills the task from the title, and rewrites the issue into a
description and starting prompt for any you left empty (`--no-distill` to skip).
Both context strategies show the issue in CLAUDE.md and the brief.

The copy is frozen at creation. To update it: `werkmeister workspace init --refresh-issue`
(the brief is not rewritten, except one that is still the untouched placeholder, which is rebuilt from the issue). `werkmeister infra connect` reports whether this machine can read
the issue tracker and, on a terminal, offers `gh auth login`.

## Caddy Proxy & Feature Selector UI

### Proxy Setup

The Caddy proxy runs as part of shared infrastructure (`infra/compose/shared-infra.yml`):

```bash
# Start (included in werkmeister connect)
docker compose -f infra/compose/shared-infra.yml up -d caddy

# Stop
docker compose -f infra/compose/shared-infra.yml stop caddy

# View logs
docker compose -f infra/compose/shared-infra.yml logs -f caddy
```

**Container details:**
- Image: `caddy:2-alpine`
- Name: `w9r-caddy`
- Ports: 80 (HTTP), 443 (HTTPS)
- Volumes: Caddyfile (read-only), UI files, Caddy data/config
- Health check: `caddy validate --config /etc/caddy/Caddyfile`

### Feature Selector UI

Visit **`https://frontend.local.werkmeister.io/__werkmeister`** in your browser to:
- See the currently active feature (from the `X-Feature` cookie)
- Switch to a different feature by typing the name and clicking "Set Feature"
- Clear the feature cookie to return to the k8s baseline

The UI sets a cookie named `X-Feature` with a 30-day expiry. Caddy reads this cookie to determine routing.

### Manual Feature Switching

Without the UI, you can set the feature via:

**Cookie (browser):**
```javascript
document.cookie = "X-Feature=my-feature; path=/; max-age=2592000";
```

**Header (curl/API tools):**
```bash
curl -H "X-Feature: my-feature" https://frontend.local.werkmeister.io/
```

**Browser extension:** Use a header-injection extension like ModHeader to add `X-Feature: my-feature` to all requests.

## k8s Port-Forwards (Containerized)

k8s port-forwards run inside a Docker container rather than as host-side shell scripts. The container is part of shared infrastructure and is managed via `infra/compose/shared-infra.yml`.

### Container Details

- **Container name**: `w9r-k8s-forwards`
- **Built from**: `infra/compose/k8s-port-forward/Dockerfile`
- **Network**: `werkmeister-shared` (accessible to all feature containers via DNS name `k8s-forwards`)
- **Health checks**: Managed by Docker health checks defined in the compose file

### Common Operations

```bash
# View port-forward logs
docker logs w9r-k8s-forwards

# Follow logs in real-time
docker logs -f w9r-k8s-forwards

# Restart the container (re-establishes all port-forwards)
docker compose -f infra/compose/shared-infra.yml restart k8s-forwards

# Check container health
docker inspect --format='{{.State.Health.Status}}' w9r-k8s-forwards
```

### How It Works

The container runs a single entrypoint script that starts all `kubectl port-forward` processes internally. If a port-forward process dies, it is automatically restarted by the entrypoint script. Docker health checks verify that all expected ports are listening inside the container.
