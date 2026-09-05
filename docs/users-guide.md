# sandbox — User's Guide

> Multi-feature concurrent development environment for Sandbox.
> Enables up to 12 features to be developed simultaneously, each running only the services that have code changes locally while everything else is served from k8s.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Concepts](#concepts)
   - [Features & Workspaces](#features--workspaces)
   - [Slots & Port Ranges](#slots--port-ranges)
   - [k8s Port-Forwards (Baseline)](#k8s-port-forwards-baseline)
   - [Caddy Reverse Proxy](#caddy-reverse-proxy)
   - [Service Auto-Detection](#service-auto-detection)
5. [Getting Started](#getting-started)
6. [CLI Reference](#cli-reference)
   - [sandbox up](#sandbox-up)
   - [sandbox down](#sandbox-down)
   - [sandbox restart](#sandbox-restart)
   - [sandbox status](#sandbox-status)
   - [sandbox detect](#sandbox-detect)
   - [sandbox services](#sandbox-services)
   - [sandbox logs](#sandbox-logs)
   - [sandbox remove](#sandbox-remove)
   - [sandbox test](#sandbox-test)
   - [sandbox k8s-connect](#sandbox-k8s-connect)
   - [sandbox k8s-status](#sandbox-k8s-status)
   - [sandbox proxy-reload](#sandbox-proxy-reload)
7. [Services Reference](#services-reference)
   - [Application Services](#application-services)
   - [Infrastructure Services](#infrastructure-services)
   - [Setup Services](#setup-services)
8. [Port Allocation](#port-allocation)
   - [Feature Slot Ports](#feature-slot-ports)
   - [k8s Forward Ports](#k8s-forward-ports)
9. [Configuration Files](#configuration-files)
   - [infra/config/services.yaml](#infraconfigservicesyaml)
   - [infra/config/ports.yaml](#infraconfigportsyaml)
   - [k8s forward table (in services.yaml)](#k8s-forward-table-in-servicesyaml)
10. [Generated Files](#generated-files)
11. [Caddy Proxy & Feature Selector UI](#caddy-proxy--feature-selector-ui)
12. [k8s Port-Forward Scripts](#k8s-port-forward-scripts)
13. [Environment Variables](#environment-variables)
14. [File Paths Reference](#file-paths-reference)
15. [Workflows](#workflows)
    - [Starting a New Feature](#starting-a-new-feature)
    - [Adding a Service Mid-Development](#adding-a-service-mid-development)
    - [Running Multiple Features Simultaneously](#running-multiple-features-simultaneously)
    - [Running Playwright Tests](#running-playwright-tests)
    - [Debugging a Service](#debugging-a-service)
16. [Troubleshooting](#troubleshooting)
17. [Architecture Diagram](#architecture-diagram)

---

## Overview

The sandbox is a CLI-driven orchestration layer that enables concurrent feature development across Sandbox's distributed architecture (~15 services across ~9 repos). Instead of running all services locally, each feature runs **only the services with code changes** in Docker containers, while everything else is transparently served from k8s via containerized `kubectl port-forward` processes.

A Caddy reverse proxy terminates HTTPS, serves the feature selector UI, and routes each service's public hostname directly. It reads an `X-Feature` cookie or header from incoming requests and routes them to the correct feature's local containers — or falls back to the k8s baseline for services that aren't running locally.

**Key benefits:**

- **Low memory footprint** — a typical feature uses 512MB–1GB (3 local services) instead of 12GB+ for the full stack
- **Feature isolation** — each feature gets its own Docker network, port range, and compose stack; no cross-contamination
- **Auto-detection** — `sandbox up` analyzes your git changes to determine which services to run
- **Up to 12 concurrent features** — enough for a full team of Claude Code agents

---

## Prerequisites

| Requirement | Purpose | Installation |
|---|---|---|
| **Node.js 20+** | CLI runtime | `brew install node` (or nvm) |
| **Docker Desktop** | Container runtime | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop) |
| **Docker Compose v2** | Container orchestration | Included with Docker Desktop |
| **kubectl** | Kubernetes CLI | `brew install kubectl` |
| **Git** | Workspace detection | Included with macOS Xcode tools |
| **Playwright** | Running browser tests | `npx playwright install` (optional) |

### Cluster Access

The k8s port-forwards need a working kubectl context. The sandbox's default is the
local OrbStack cluster, named by the top-level `k8s_context` key in
`~/.sandbox/services.yaml` (e.g. `k8s_context: orbstack`).

```bash
kubectl config get-contexts        # list available contexts
kubectl config current-context     # confirm the active one
kubectl get nodes                  # confirm the cluster answers
```

Authentication is whatever your kubeconfig already carries — OrbStack embeds a
client cert, so no cloud-provider CLI or auth plugin is required. If you point
`k8s_context` at a remote cluster, set that context up with your provider's own
tooling first; the sandbox only reads the resulting kubeconfig.

### Workspace Directory

The sandbox supports two workspace layouts:

**Standalone layout** (default) — repos checked out flat in `~/workspace/`:

```
~/workspace/
└── sandbox/            # standard git clone
```

Feature names are arbitrary labels (not directory names). Override the default path with `--workspace` or the `WORKSPACE` env var.

**Multi-feature layout** — per-feature workspace nesting (one parent dir, one subdir per feature, repo worktrees under each). Activated by setting `SANDBOX_WORKSPACES_ROOT` and laying out subdirectories like:

```
~/workspace/         # set SANDBOX_WORKSPACES_ROOT to this
├── feature-abc/
│   └── sandbox/        # git worktree of the sandbox repo
├── feature-xyz/
│   └── sandbox/
└── ...
```

In this layout each feature maps to a subdirectory containing its repo worktrees. This layout is what Vibe Kanban's automation produces by default, but the sandbox itself is layout-agnostic — any directory with worktrees under `SANDBOX_WORKSPACES_ROOT/<feature>/` works.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/jbbz-sandbox/sandbox.git
cd sandbox

# Build the CLI once, then run it:
npm install
npm --prefix apps/cli run build

# ./sandbox resolves a node runtime (SANDBOX_NODE -> PATH -> newest nvm)
# and execs apps/cli/dist/main.js.
./sandbox --help
```

After the initial build, `./sandbox` is self-contained — it resolves a node runtime and execs the compiled CLI. Rebuild (`npm --prefix apps/cli run build`) after pulling changes to `apps/cli/src/`.

### Required Environment Variables

Create a `.env` file in the repository root (see `.env.example`):

```bash
# Optional — only needed by services that use them. The demo services
# (backend, frontend) require none.
GITHUB_AUTH_TOKEN=ghp_...          # npm registry access for private packages
```

---

## Concepts

### Features & Workspaces

A **feature** is a named unit of development work. The feature name is an arbitrary label used for slot allocation, container naming, and proxy routing.

By default, the sandbox looks for repos in `~/workspace/`. Override with `--workspace`, the legacy `WORKSPACE` env var, or `SANDBOX_WORKSPACES_ROOT` (preferred) for per-feature workspace nesting.

**Resolution priority** (see `resolve_workspace` in `apps/cli/src/lib/config.ts`):
1. `--workspace` flag (explicit path)
2. `SANDBOX_WORKSPACES_ROOT` env var (preferred)
3. `SANDBOX_WORKSPACE_ROOT` env var (deprecated alias — removed in v2)
4. `WORKSPACE` env var (legacy alias, kept for back-compat)
5. Auto-detect from the current directory — walk up to the nearest `.git` boundary and use its parent, so you can run `sandbox` from inside a repo/worktree
6. `~/workspace/` (fallback)

When you run `sandbox up my-feature`, the CLI:
1. Resolves the workspace directory (default: `~/workspace/`, or per the priority above)
2. Finds repo directories that match entries in `infra/config/services.yaml`
3. Runs `git diff main..HEAD --name-only` in each to find changed files
4. Maps changed files to services using `infra/config/services.yaml`
5. Starts only those services locally

### Initializing a Workspace

`sandbox init-workspace` writes the per-feature `CLAUDE.md` and `.env` into the workspace root. Each input resolves in this order (first non-empty wins):

1. **CLI flag** — `--feature`, `--services`, `--jira-id`, `--test-path`, `--description`, `--task`
2. **`SANDBOX_*` env var** — `SANDBOX_FEATURE`, `SANDBOX_SERVICES`, `SANDBOX_JIRA_ID`, `SANDBOX_TEST_PATH`, `SANDBOX_DESCRIPTION`, `SANDBOX_TASK`
3. **Config file** — `<workspace>/.sandbox/workspace.yml` (override with `--config <path>` or `SANDBOX_WORKSPACE_CONFIG`; legacy `workspace.jsonc` / `workspace.json` are still read)
4. **Stdin / defaults** — piped stdin or a slug-derived hint from the workspace directory name (for `task`)

```bash
sandbox init-workspace \
    --feature blog \
    --services frontend,backend \
    --jira-id PROJ-1234
```

### Slots & Port Ranges

Each active feature is assigned a **slot** (numbered 1–12). The slot determines the feature's host port range:

| Slot | Port Range | Example (port_offset 0) |
|---|---|---|
| 1 | 11100–11119 | `localhost:11100` |
| 2 | 11200–11219 | `localhost:11200` |
| 3 | 11300–11319 | `localhost:11300` |
| ... | ... | ... |
| 12 | 12200–12219 | `localhost:12200` |

Each slot provides 20 ports. A service's host port is calculated as:

```
host_port = base_port + (slot - 1) * 100 + port_offset
```

Where `port_offset` is defined per service in `~/.sandbox/services.yaml` (in the demo registry: backend = 0, frontend = 1).

Slot assignments are persisted in `~/.sandbox/slots.json` and survive terminal restarts.

### k8s Port-Forwards (Baseline)

All services are available from k8s on a fixed port range (9000–9099), shared across all features. These are the "baseline" — when a feature doesn't run a service locally, requests are routed to the k8s forward.

k8s port-forwards now run inside a Docker container (`k8s-forwards`) as part of shared infrastructure (`infra/compose/shared-infra.yml`). They are accessible via the Docker DNS name `k8s-forwards` on the `sandbox-shared` network.

| Port | Service | k8s Namespace |
|---|---|---|
| 9050 | redis | default |
| 9051 | postgres | default |
| 9052 | backend | default |
| 9053 | frontend | default |

These ports are internal to the Docker network — other containers reach them via `k8s-forwards:9xxx`. k8s forwards must be running before starting features. Start them with `sandbox connect`.

### Caddy Reverse Proxy

Caddy runs as a Docker container (ports 80 and 443) and provides:

1. **HTTPS termination** — Caddy terminates HTTPS on port 443 using locally-trusted certificates
2. **Feature selector UI** — a web page at `https://frontend.local.sandbox.com/__sandbox` for setting the active feature in your browser
3. **Feature resolution** — Caddy matches the `X-Feature` cookie and reverse-proxies to that feature's local container, falling back to the k8s baseline when the service isn't running locally
4. **Per-service hostnames** — each routed service gets its own hostname derived from `ingress.local_domain` (e.g., `frontend.local.sandbox.com`)

The Caddyfile is regenerated automatically whenever you run `sandbox up`, `sandbox down`, `sandbox remove`, or `sandbox proxy-reload`.

### Service Auto-Detection

When `sandbox up <feature>` or `sandbox detect <feature>` is run, the detection algorithm:

1. Resolves the workspace directory (see [Features & Workspaces](#features--workspaces))
2. Lists all non-hidden subdirectories that match known repo names from `infra/config/services.yaml`
3. For each repo, runs `git diff main..HEAD --name-only` (falls back to `origin/main` if `main` branch doesn't exist locally)
4. Maps the repo name and changed file paths to services using the `repos` section of `infra/config/services.yaml`
5. For monorepos, uses `path_mappings` to match specific subdirectories to specific services

**Example:** If `demo-services/apps/frontend/app/page.tsx` is changed, the detector maps:
- Repo: `demo-services`
- Path matches: `apps/frontend` → service `frontend`

**Skipping auto-detection:** Pass `--services` (or `-s`) to `sandbox up` to specify services explicitly instead of relying on git diff. See [sandbox up](#sandbox-up).

### Concurrency & Isolation

Each feature runs in an isolated environment:

- **Docker networks** — each feature gets its own bridge network (`sandbox-<feature>`)
- **Container names** — prefixed with the feature name (`<feature>-<service>`)
- **Named volumes** — `node_modules`, build caches, and other named volumes are prefixed with the feature name (e.g., `my-feature-frontend_node_modules`) so concurrent features never share mutable state
- **Port ranges** — each feature's slot maps to a dedicated host port range (see [Slots & Port Ranges](#slots--port-ranges))
- **Generated files** — each feature's `docker-compose.yml` and `.env` are written to its workspace root, and `supergraph-config.yml` to `<workspace>/.sandbox/`

**Single-repo concurrency note:** In single-repo mode (`~/workspace/` with one checkout per repo), all features share the same source code checkout. This means two features modifying the same repo will see each other's uncommitted changes. For true concurrent multi-feature development, use the per-feature workspace layout via `SANDBOX_WORKSPACES_ROOT=<parent>` and place git worktrees under each feature subdir.

---

## Getting Started

### Step 1: Start Shared Infrastructure

Start all shared infrastructure (k8s-forwards, jaeger, redisinsight, caddy):

```bash
./sandbox connect
```

Verify k8s forwards are healthy:

```bash
./sandbox k8s-status
```

### Step 2: Configure Local DNS

Add to `/etc/hosts`:

```
127.0.0.1 frontend.local.sandbox.com
```

### Step 3: Start a Feature

```bash
# Auto-detect and start services (scans ~/workspace/ by default)
./sandbox up my-feature

# Or point to a different repo directory
./sandbox up my-feature --workspace /path/to/repos

# Skip auto-detection — specify services explicitly
./sandbox up my-feature --services backend,frontend
./sandbox up my-feature -s frontend

# Force start with no services (all traffic goes to k8s)
./sandbox up my-feature --force
```

### Step 5: Access Your Feature

**Option A: Browser cookie**
Visit `https://frontend.local.sandbox.com/__sandbox`, type your feature name, and click "Set Feature". All subsequent requests in that browser will be routed to your feature.

**Option B: HTTP header**
Use a browser extension or curl:
```bash
curl -H "X-Feature: my-feature" https://frontend.local.sandbox.com/
```

### Step 6: View Status

```bash
./sandbox status
```

### Step 7: Tear Down

```bash
./sandbox down my-feature
```

---

## CLI Reference

All commands are invoked via the `./sandbox` wrapper script. Run `./sandbox --help` for a list of commands, or `./sandbox <command> --help` for command-specific help.

### Debugging

Set the `SANDBOX_DEBUG` environment variable to get full stack traces on errors:

```bash
SANDBOX_DEBUG=1 ./sandbox up my-feature
```

---

### sandbox up

**Start a feature's local development environment.**

```
./sandbox up <feature> [--force] [--workspace <path>] [--services <svc,...>]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name (arbitrary label for slot allocation and proxy routing) |
| `--force` | No | Start even if no changed services are detected |
| `--workspace`, `-w` | No | Path to directory containing repo checkouts. Default: `~/workspace/`. Also settable via `WORKSPACE` env var. |
| `--services`, `-s` | No | Comma-separated list of services to run locally (e.g. `backend,frontend`). Skips git diff auto-detection entirely. |

**What it does:**

1. Loads service registry and port configuration
2. Resolves the workspace (default: `~/workspace/`) and scans for changed services — or uses the explicit list from `--services` if provided
3. Allocates a slot (1–12) if the feature doesn't already have one
4. Generates per-feature files in the feature's workspace:
   - `docker-compose.yml` — Docker Compose stack definition (workspace root)
   - `.env` — Environment variables with resolved service URLs (workspace root)
   - `<workspace>/.sandbox/supergraph-config.yml` — Apollo Federation config
5. Verifies k8s port-forwards are healthy (restarts if needed)
6. Starts containers with `docker compose up -d --build --remove-orphans`
7. Regenerates `infra/proxy/Caddyfile` and reloads Caddy

**Output example:**

```
[info] Scanning workspace for feature: my-feature
[info] Detected 2 service(s): backend, frontend
[ok]   Allocated slot 1 (ports 11100-11119)
[info] Generating config files...
[info] Starting containers...
[ok]   Feature 'my-feature' is up!

  URL:       https://frontend.local.sandbox.com
  Header:    X-Feature: my-feature
  Slot:      1
  Ports:     11100-11119
  Services:  backend (:11100), frontend (:11101)
```

**If no services are detected** and `--force` is not set, the command prints a warning but still proceeds — the feature is registered and routes entirely to k8s. You can add services later with `sandbox up <feature> -s <service>` (or by editing `.sandbox/workspace.yml` and rerunning `sandbox init-workspace`).

**If all 12 slots are occupied**, the command exits with an error. Free a slot by running `sandbox down` on another feature.

---

### sandbox down

**Stop a feature and release its resources.**

```
./sandbox down <feature> [--volumes]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| `--volumes`, `-v` | No | Also remove per-feature Docker volumes (node_modules, caches) |

**What it does:**

1. Stops all Docker containers for the feature (`docker compose down --remove-orphans`)
2. Releases the slot back to the pool
3. Regenerates the Caddyfile (removing this feature's routing rules)
4. Reloads Caddy if running
The feature's generated files (`docker-compose.yml`, `.env`, `.sandbox/`) are left in place in its workspace — they're overwritten on the next `sandbox up`.

By default, per-feature Docker volumes (node_modules, build caches) are preserved so the next `sandbox up` is faster. Use `--volumes` to remove them for a full cleanup.

The command is safe to run even if the feature is already stopped — it will clean up any leftover state.

---

### sandbox restart

**Restart a feature's containers without regenerating config.**

```
./sandbox restart <feature>
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |

Useful after making code changes that hot-reload doesn't pick up. If the feature doesn't have a slot, prints an error suggesting `sandbox up` instead.

---

### sandbox status

**Show all active features and their status.**

```
./sandbox status [-v]
```

| Flag | Description |
|---|---|
| `-v`, `--verbose` | Show individual container details (name, status, ports) |

**Output example:**

```
  Slot  Feature         Services                          Ports          Status
  ──────────────────────────────────────────────────────────────────────────────
  1     my-feature      backend, frontend            11100-11119    up (2/2)
  3     other-feature   frontend                        11300-11319    partial (0/1)

  2 active feature(s), 10 slot(s) available
```

**Status indicators:**
- `up (N/M)` (green) — all containers running
- `partial (N/M)` (yellow) — some containers running
- `down (0/M)` (red) — no containers running
- `no containers` (dim) — compose file exists but no containers found

---

### sandbox detect

**Preview which services would run locally (dry run).**

```
./sandbox detect <feature> [--workspace <path>]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| `--workspace`, `-w` | No | Path to directory containing repo checkouts. Default: `~/workspace/`. Also settable via `WORKSPACE` env var. |

This command does **not** start anything. It scans the workspace, runs git diff analysis, and reports which services have changes. Useful for verifying detection before running `sandbox up`.

**Output example:**

```
[info] Scanning workspace: ~/workspace

Detected services:
  frontend          repo: sandbox     type: web

Services from k8s (no local changes):
  backend
```

---

### sandbox services

**List service endpoints for a running feature.**

```
./sandbox services <feature>
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |

Shows each service with its source (local container or k8s forward) and endpoint:

```
  Service                Source    Endpoint              Type
  ────────────────────────────────────────────────────────────
  backend             k8s      localhost:9052         api
  frontend             local    localhost:11101        web
```

---

### sandbox logs

**Tail Docker Compose logs for a feature.**

```
./sandbox logs <feature> [service]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| `service` | No | Specific service to tail (omit for all services) |

Streams logs in real-time (equivalent to `docker compose logs -f --tail 100`). Press `Ctrl+C` to stop.

```bash
# All services
./sandbox logs my-feature

# Just frontend
./sandbox logs my-feature frontend
```

---

### Adding a service to a running feature

There is no `sandbox add` command. To force a service to run locally:

- **On the fly:** `sandbox up <feature> -s <service>` — brings the feature up
  (or back up) with that service running locally.
- **Durably:** add the service to the `services` field in the workspace's
  `.sandbox/workspace.yml`, then rerun `sandbox init-workspace` — this also
  adds the owning repo's worktree if it isn't present yet.

---

### sandbox remove

**Remove a local service, falling back to k8s.**

```
./sandbox remove <feature> <service>
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| `service` | Yes | Service name |

Removes the service from the feature's local stack. The service will now be served from k8s. Config files are regenerated and Caddy is reloaded.

If removing the last service, the feature's containers are fully stopped (though the slot remains allocated — use `sandbox down` to release it).

```bash
./sandbox remove my-feature frontend
```

---

### sandbox test

**Run Playwright tests against a feature.**

```
./sandbox test <feature> [-- extra-args...]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| extra args | No | Additional arguments passed to `npx playwright test` |

**What it does:**

1. Sets environment variables `SANDBOX_FEATURE` and `SANDBOX_SLOT` for the Playwright process
2. Searches for a `playwright.config.ts` (or `.js`/`.mjs`) in the following locations, in order:
   - `~/workspace/<feature>/sandbox/`
   - `~/workspace/<feature>/`
   - The sandbox root directory
3. Runs `npx playwright test` with a 10-minute timeout

```bash
# Run all tests
./sandbox test my-feature

# Run specific test file
./sandbox test my-feature -- tests/homepage.spec.ts

# Run with headed browser
./sandbox test my-feature -- --headed
```

The feature doesn't need to have an active slot — if it doesn't, the command warns but proceeds with just the feature header routing.

---

### sandbox k8s-connect

**Start or check the containerized k8s port-forwards.**

```
./sandbox k8s-connect
```

No arguments. Starts the `k8s-forwards` Docker container (part of `infra/compose/shared-infra.yml`) which runs all 12 `kubectl port-forward` processes (9 application + 3 infrastructure) inside a single container. If the container is already running, the command checks its health status.

The container runs on the `sandbox-shared` Docker network and is accessible to other containers via the DNS name `k8s-forwards`. Port-forward processes inside the container auto-restart if they disconnect, managed by the container's entrypoint script.

After starting, it runs a health check and reports the status.

```
[info] Starting k8s-forwards container...
[ok]   k8s-forwards container is healthy. 12/12 forwards active.
```

---

### sandbox k8s-status

**Check the health of the k8s port-forwards container.**

```
./sandbox k8s-status
```

No arguments. Checks the Docker container health of `sandbox-k8s-forwards` and reports the status of each forwarded port:

```
  Container: sandbox-k8s-forwards    Status: healthy

  Service                Port   k8s Target                            Status
  ─────────────────────────────────────────────────────────────────────────────────
  redis                  9050   default/redis:6379                    healthy
  postgres               9051   default/postgres:5432                 healthy
  backend             9052   default/backend:80                 healthy
  redis                  9050   dev:6379                              healthy
  frontend             9053   default/frontend:8080               down

  11/12 healthy, 1 down
  Run 'sandbox k8s-connect' to restart the k8s-forwards container
```

---

### sandbox proxy-reload

**Regenerate the Caddyfile and reload Caddy.**

```
./sandbox proxy-reload
```

No arguments. Reads all active slot assignments, regenerates `infra/proxy/Caddyfile`, and reloads (or starts) Caddy. Useful after manual config changes or if the proxy gets out of sync.

---

### sandbox clean

**Remove orphaned Docker volumes and generated files from stopped features.**

```
./sandbox clean [--all] [--dry-run]
```

| Argument | Required | Description |
|---|---|---|
| `--all` | No | Also tear down and clean all active features |
| `--dry-run` | No | Show what would be removed without taking action |

**What it does:**

1. Identifies per-feature Docker volumes (node_modules, build caches) that belong to stopped features
2. Removes those orphaned volumes
3. Releases stale slot entries (features with no running containers or compose file)

With `--all`, it first stops all active features (equivalent to running `sandbox down --volumes` for each), then cleans everything.

**When to use:**
- After extended development with many features started and stopped — volumes accumulate
- Before a fresh start: `./sandbox clean --all`
- To check what would be cleaned: `./sandbox clean --dry-run`

---

## Cleanup & Disk Usage

Running multiple features concurrently creates per-feature Docker volumes for `node_modules` and build caches. These persist after `sandbox down` (by design — to speed up subsequent `sandbox up`).

**Per-feature cleanup:**
```bash
# Stop a feature and keep volumes (faster next startup)
./sandbox down my-feature

# Stop a feature and remove its volumes
./sandbox down my-feature --volumes
```

**Bulk cleanup:**
```bash
# See what's orphaned (safe — no changes)
./sandbox clean --dry-run

# Remove orphaned volumes and generated files from stopped features
./sandbox clean

# Nuclear option: tear down everything
./sandbox clean --all
```

**Manual volume inspection:**
```bash
# List all sandbox-related Docker volumes
docker volume ls | grep -E '^\S+-(backend|frontend)'

# Remove a specific volume
docker volume rm my-feature-frontend_node_modules
```

Each feature's volumes follow the naming pattern `<feature>-<volume_name>` (e.g., `my-feature-frontend_node_modules`). This ensures concurrent features never share mutable Docker state.

---

## Services Reference

### Application Services

The registry is `~/.sandbox/services.yaml`. The shipped demo registry defines two
services in the `demo-services` repo — a small turborepo cloned alongside
`sandbox` under `paths.repos_root`:

| Service | Repo | Path in Repo | Type | Internal Port | port_offset | Health Endpoint |
|---|---|---|---|---|---|---|
| backend | demo-services | `apps/backend` | api | 3000 | 0 | /health |
| frontend | demo-services | `apps/frontend` | web | 3000 | 1 | / |

Add your own by appending to `services:` (and `repos:`) in that file — the columns above
are the required keys. `sandbox services` lists whatever is registered.

### Infrastructure Services

These are always served from k8s — they are never run locally:

| Service | k8s Forward Port | Internal Port | Namespace |
|---|---|---|---|
| Redis | 9050 | 6379 | default |
| PostgreSQL | 9051 | 5432 | default |

### Setup Services

Monorepo services require initialization before the application services can start. Setup services install dependencies and build shared packages:

| Setup Service | Repo | Monorepo Type | Memory Limit | Purpose |
|---|---|---|---|---|
| _(none)_ | — | — | — | The demo registry defines no setup services. Add them under `setup_services:` in `~/.sandbox/services.yaml` for monorepos that need a shared install/build step before their services start. |

Setup services are automatically included in generated Docker Compose files when a feature uses services from the corresponding monorepo.

### Self-hosting the sandbox repo

The five workspaces of this repo (`apps/cli`, `apps/claudeck`, `apps/sandbox-dashboard`,
`packages/sandbox-core`, `packages/vscode-plugin`) can be registered as services so a
feature workspace develops the sandbox itself, each package in its own container. The
registry shape lives in `docs/superpowers/specs/2026-09-03-self-host-services-design.md`;
the pieces that are not obvious from the demo services:

- **One `node:22` image everywhere.** `better-sqlite3`, `keytar`, `sharp` and the
  esbuild/rollup/swc binaries ship glibc prebuilds only; alpine will not load them.
- **Watch loops need no listener.** The compose template always publishes a port and its
  healthcheck is `curl … || exit 0`, so `tsc --watch` containers read healthy with a
  placeholder `internal_port`.
- **Host access for `cli`, `sandbox-dashboard` and `claudeck`.** Those three drive the host:
  they get `/var/run/docker.sock` plus `~/.sandbox`, `~/repos`, `~/features` and `~/.kube`
  bind-mounted at their *host* paths, `HOME` set to match, and the docker, compose and
  kubectl binaries from the per-feature `tools` volume that
  `infra/compose/scripts/sandbox-install-startup.sh` fills. The generated compose files carry
  host bind-mount paths and the daemon is the host's, so the paths must be identical on both
  sides.
- **`sandbox` inside the container is the worktree's own build.** `PATH` puts
  `/app/apps/cli` first. `sandbox_root` in `~/.sandbox/config.yaml` still points at the main
  checkout, so templates and `infra/` come from there (see the known issue on machine-global
  `sandbox_root`). **Never run `sandbox config` or `sandbox setup` from a worktree**, on the
  host or in the container: it silently repoints the whole machine.
- **The dashboard binds `HOST`.** It defaults to loopback for the reasons in `main.ts`; the
  registry sets `HOST=0.0.0.0` because the container network is the isolation boundary and
  Docker's published port is the only way in.
- **New hostnames need `/etc/hosts` entries.** The wildcard certificate already covers
  `*.local.sandbox.com`, but `sandbox-dashboard.local.sandbox.com` and
  `claudeck.local.sandbox.com` only resolve after `sandbox setup` (run from the main
  checkout) reconciles `/etc/hosts`, which needs sudo. Caddy emits their site blocks only
  once a running feature declares the service.
- **Claudeck chat needs an Anthropic key.** Add `ANTHROPIC_API_KEY` to
  `~/.sandbox/secrets.env` *and* `secrets: [ANTHROPIC_API_KEY]` to the `claudeck` entry
  together: a declared-but-missing secret makes `sandbox up` refuse the whole workspace.
- **The container's npm rewrites `package-lock.json`.** `node:22` ships npm 10.9.x, which
  strips the `libc` fields a newer host npm writes. Discard that diff in the worktree unless
  you actually changed dependencies.
- **Inside the container, `sandbox status` shows every k8s forward as dead** and `kubectl`
  cannot reach OrbStack's API server: both probe `127.0.0.1`, which is the container's own
  loopback. The forwards are fine; read their state from the host. `sandbox up`, `down`,
  `status` (for features) and `workspace` all work from inside. This applies to a container
  running the CLI *directly*. A container that calls the host MCP surface (`apps/mcp`)
  instead is unaffected: `sandbox-status` runs on the host, so the forward health it reports
  is the real one.
- **Not covered:** the `gh` and `claude` binaries. Telepresence intercepts need a root daemon
  on the host, so `sandbox intercept` and `sandbox connect` must run there — either from a
  host terminal, or through the `sandbox-intercept` and `sandbox-connect` tools on
  `apps/mcp`, which run host-side with exactly the authority a host terminal has.
- **A container can instead hold no daemon at all.** `apps/mcp` (port 3002, started by
  `sandbox connect`) exposes twenty sandbox verbs over authenticated HTTP, so a container
  needs only `~/repos`, `~/features` and `SANDBOX_MCP_TOKEN` — no docker socket, no docker
  CLI, no kubectl, no `sandbox` binary. It is the only managed web server that binds
  `0.0.0.0`, via a per-app `env` on its `WebApp` entry; never arrange that by exporting
  `HOST` before `sandbox connect`, which would also expose the unauthenticated dashboard.
  Its `mcp_servers.sandbox` registry entry is deliberately in no archetype — `.mcp.json` is
  shared with host sessions, where `host.docker.internal` does not resolve. See
  `apps/mcp/README.md`.
- **Wiring a service to drive the sandbox that way** takes four edits to
  `~/.sandbox/services.yaml`, and the granularity is the *service*, not the workspace —
  `services:` entries are machine-global, so a fresh workspace does not isolate a change.
  1. A top-level `x-mcp-client:` block **above** `services:` (YAML resolves anchors in
     document order) holding `mounts: &mcp_client_mounts` — `~/repos` and `~/features` at
     identical host paths — and `env: &mcp_client_env` — `HOME` and the `GIT_CONFIG_*`
     `safe.directory` trio. Loaders read seven top-level keys, so `x-`-prefixed ones are
     ignored. No socket, no `~/.sandbox`, no `~/.kube`, no tools volume: the host server
     holds all of that.
  2. `extra_volumes: *mcp_client_mounts` and `environment: *mcp_client_env` on the service.
  3. An archetype of its own carrying `mcp_servers: [sandbox]`, worn only by that service.
     Hand-adding `sandbox` to a workspace's `.mcp.json` does **not** stick — the projection
     prunes any registry-known server the present archetypes don't want, so the next
     `init-workspace` deletes it.
  4. `SANDBOX_MCP_TOKEN` in `~/.sandbox/secrets.env` (copy `~/.sandbox/mcp-token`) *and*
     `secrets: [SANDBOX_MCP_TOKEN]` on the service entry, which routes it through the
     feature `.env`. Never put `${SANDBOX_MCP_TOKEN}` in the service's `environment:`:
     compose expands it from whichever shell ran it — for the `sandbox-up` tool, the MCP
     server's own env, where it is unset — and `environment:` beats `env_file:`, so it
     would shadow the real value with an empty string.

  Then `sandbox init-workspace` and `sandbox down <feature> && sandbox up <feature>`. To
  check it, `docker exec` into the container and POST an MCP `initialize` to
  `http://host.docker.internal:3002/mcp` with `Authorization: Bearer $SANDBOX_MCP_TOKEN`
  and `Accept: application/json, text/event-stream` — and no `Origin` header, which the
  server rejects with 403. Drive a *different* feature than the container's own: tearing
  down its own feature kills the caller mid-call.

---

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

| Port | Service |
|---|---|

| 9050 | redis |
| 9051 | postgres |
| 9052 | backend |
| 9053 | frontend |

---

## Configuration Files

### infra/config/services.yaml

The central service registry. Defines all services, their repos, paths, ports, k8s details, and dependencies.

**Top-level keys:**

- **`services`** — Map of service name to service definition. Each service has:
  - `repo` (string) — Repository name (directory name in workspace)
  - `path` (string) — Path within the repo (`.` for entire repo, `apps/frontend` for monorepo packages)
  - `type` (string) — Service category: `web`, `api`, `graphql-subgraph`, `graphql-gateway`
  - `internal_port` (int) — Port the service listens on inside its container
  - `port_offset` (int) — Offset within the feature slot range (0–19)
  - `k8s_deployment` (string | null) — Kubernetes deployment name
  - `k8s_namespace` (string | null) — Kubernetes namespace
  - `k8s_port` (int | null) — Port the k8s pod listens on
  - `k8s_pod_prefix` (string | null) — Pod name prefix for kubectl
  - `health_endpoint` (string) — HTTP path for health checks
  - `monorepo` (string | null) — `turbo` or `nx` if part of a monorepo
  - `setup_service` (string | null) — Required setup service name
  - `memory_limit` (string) — Docker memory limit (e.g., `2G`, `2560M`)
  - `memory_reservation` (string) — Docker memory reservation
  - `environment` (map | null) — Additional env vars for the service
  - `command` (string | null) — Custom startup command
  - `depends_on` (list | null) — Service dependencies
  - `extra_services` (map | null) — Sidecar containers (e.g., Redis instances)
  - `node_modules_volume` (bool) — Whether to use a named volume for node_modules
  - `extra_volumes` (list | null) — Additional volume mounts

- **`infrastructure`** — Infrastructure services (redis, postgres) with k8s forward ports
- **`setup_services`** — Optional per-monorepo install/build steps that run before a repo's services start
- **`repos`** — Repo-to-service mapping with `path_mappings` for monorepos

### infra/config/ports.yaml

Port allocation scheme:

```yaml
feature_slots:
  count: 12          # Maximum concurrent features
  base_port: 11100   # Starting port for slot 1
  ports_per_slot: 20  # Ports available per slot
```

(k8s forward listen-ports live per-service in `services.yaml` as
`k8s_forward_port:` — the single source of truth for the forward table.)

### k8s forward table (in services.yaml)

The k8s port-forward table is not a separate file — each forwarded service in
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
`sandbox connect` (`apps/cli/src/lib/k8s_forwards.ts`): the container's forward list is
written to `k8s-port-forward/tmp/forwards` (mounted at `/tmp/forwards`, read by
`entrypoint.sh`), and the `k8s-forwards` service's `ports:`/`aliases:` in
`shared-infra.yml` are regenerated in place between `# >>> GENERATED` markers.
`apps/cli/src/lib/__tests__/k8s_forward_drift.test.ts` fails if the committed
`shared-infra.yml` drifts out of sync. To add or change a forward, edit only
`services.yaml` and run `sandbox connect`.

---

## Generated Files

When you run `sandbox up <feature>`, three files are generated in the feature's workspace — `docker-compose.yml` and `.env` at the workspace root, and `supergraph-config.yml` under `<workspace>/.sandbox/`:

### docker-compose.yml

Per-feature Docker Compose stack containing:
- **Network**: An isolated bridge network named `sandbox-<feature>`
- **Setup services** (if needed): Node.js containers that install monorepo dependencies before application services start
- **Application services**: One container per local service with:
  - Source code mounted from the workspace
  - Port mapping from the feature's slot range to the service's internal port
  - Environment variables with resolved URLs for all services (Docker DNS names for local services, `k8s-forwards:9xxx` for k8s services)
  - Memory limits from `services.yaml`
  - Health checks using `curl` to the service's health endpoint
  - `depends_on` the setup service (with `service_healthy` condition)
- **Networks**: Feature containers join both the feature-specific network (`sandbox-<feature>`) and the `sandbox-shared` network, enabling communication with shared infrastructure (k8s-forwards, jaeger, redisinsight, caddy)

### .env

Environment file loaded by Docker Compose, containing:
- `SANDBOX_FEATURE`, `SANDBOX_SLOT`, `COMPOSE_PROJECT_NAME`
- Node.js version and environment settings
- Resolved URLs for every service (e.g., `FRONTEND_URL=http://frontend:3000`)
- Database connection strings pointing to shared infrastructure (e.g., `REDIS_URL=redis://redis:6379`)

### supergraph-config.yml

Apollo Federation supergraph configuration. Lists each GraphQL subgraph with its URL — local services point to slot ports, remote services point to k8s forwards.

---

## Caddy Proxy & Feature Selector UI

### Proxy Setup

The Caddy proxy runs as part of shared infrastructure (`infra/compose/shared-infra.yml`):

```bash
# Start (included in sandbox connect)
docker compose -f infra/compose/shared-infra.yml up -d caddy

# Stop
docker compose -f infra/compose/shared-infra.yml stop caddy

# View logs
docker compose -f infra/compose/shared-infra.yml logs -f caddy
```

**Container details:**
- Image: `caddy:2-alpine`
- Name: `sandbox-caddy`
- Ports: 80 (HTTP), 443 (HTTPS)
- Volumes: Caddyfile (read-only), UI files, Caddy data/config
- Health check: `caddy validate --config /etc/caddy/Caddyfile`

### Feature Selector UI

Visit **`https://frontend.local.sandbox.com/__sandbox`** in your browser to:
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
curl -H "X-Feature: my-feature" https://frontend.local.sandbox.com/
```

**Browser extension:** Use a header-injection extension like ModHeader to add `X-Feature: my-feature` to all requests.

---

## k8s Port-Forwards (Containerized)

k8s port-forwards run inside a Docker container rather than as host-side shell scripts. The container is part of shared infrastructure and is managed via `infra/compose/shared-infra.yml`.

### Container Details

- **Container name**: `sandbox-k8s-forwards`
- **Built from**: `infra/compose/k8s-port-forward/Dockerfile`
- **Network**: `sandbox-shared` (accessible to all feature containers via DNS name `k8s-forwards`)
- **Health checks**: Managed by Docker health checks defined in the compose file

### Common Operations

```bash
# View port-forward logs
docker logs sandbox-k8s-forwards

# Follow logs in real-time
docker logs -f sandbox-k8s-forwards

# Restart the container (re-establishes all port-forwards)
docker compose -f infra/compose/shared-infra.yml restart k8s-forwards

# Check container health
docker inspect --format='{{.State.Health.Status}}' sandbox-k8s-forwards
```

### How It Works

The container runs a single entrypoint script that starts all `kubectl port-forward` processes internally. If a port-forward process dies, it is automatically restarted by the entrypoint script. Docker health checks verify that all expected ports are listening inside the container.

---

## Environment Variables

| Variable | Used By | Default | Purpose |
|---|---|---|---|
| `SANDBOX_ROOT` | CLI, all commands | Auto-detected from script location | Root path of the sandbox repository. Set from `~/.zshenv` (not `~/.zshrc`) so non-interactive shells (Claude Code's Bash tool, cron, MCP servers) can see it — see [docs/known-issues.md](known-issues.md#sandbox-env-vars-in-zshrc-are-invisible-to-non-interactive-shells). |
| `SANDBOX_DEBUG` | CLI dispatcher | (not set) | When set to any value, print full stack traces on errors |
| `SANDBOX_WORKSPACES_ROOT` | config, detect | `~/workspace` | Root directory containing feature workspaces. Set from `~/.zshenv` (not `~/.zshrc`) for the same non-interactive-shell reason as `SANDBOX_ROOT` above. Deprecated aliases (kept for back-compat, removed in v2): `SANDBOX_WORKSPACE_ROOT` (singular form), `WORKSPACE` (legacy), `VIBE_WORKSPACES_ROOT` (pre-VK-decoupling). |
| `SANDBOX_FEATURE` | test command, .env | (not set) | Set in the environment of Playwright test processes |
| `SANDBOX_SLOT` | test command, .env | (not set) | Set in the environment of Playwright test processes |
| `GITHUB_AUTH_TOKEN` | .env, containers | (required) | GitHub token for npm registry access |
| `POSTGRES_INSTANCE` | .env | (required) | Cloud SQL Proxy instance connection string |

---

## File Paths Reference

### Sandbox Repository

| Path | Description |
|---|---|
| `sandbox` | Bash entrypoint (runs the CLI via uv; falls back to venv+pip) |
| `apps/cli/src/main.ts` | CLI dispatcher |
| `apps/cli/src/commands/` | Command modules (up, down, status, etc.) |
| `apps/cli/src/lib/` | Shared libraries (config, detect, slots, generate, docker, k8s, caddy) |
| `infra/config/services.yaml` | Service registry |
| `infra/config/ports.yaml` | Port allocation scheme |
| `infra/compose/` | Per-service base Docker Compose fragments |
| `infra/compose/k8s-port-forward/` | Dockerfile and entrypoint for containerized k8s port-forwards |
| `infra/templates/` | nunjucks templates for per-feature file generation |
| `infra/compose/shared-infra.yml` | Shared infrastructure (k8s-forwards, jaeger, redisinsight, caddy) |
| `infra/proxy/Caddyfile` | Generated Caddy config (gitignored) |
| `infra/proxy/ui/index.html` | Feature selector web UI |
| `apps/graphql-tools/` & `apps/otel-init/` | Node.js tooling (now an npm-workspaces monorepo with a root `package.json` + single root `package-lock.json`): GraphQL extract/validate scripts and `apps/graphql-tools/queries/` in `apps/graphql-tools/`, OTel source in `apps/otel-init/` |
| `bin/` | Setup helper scripts (authenticate, generate-certs, generate-env, ...) |
| `apps/cli/dist/` | Compiled CLI (`tsc` output; `./sandbox` execs `dist/main.js`, gitignored) |
| `package.json` / `package-lock.json` | Workspace metadata + pinned dependency lock (npm workspaces, root-level) |

### User Home Directory

| Path | Description |
|---|---|
| `~/.sandbox/slots.json` | Active slot assignments for all features |
| `~/workspace/<feature>/` | Feature workspace containing repo worktrees |

---

## Workflows

### Starting a New Feature

```bash
# 1. Ensure k8s baseline is running
./sandbox k8s-connect
./sandbox k8s-status

# 2. Create your workspace directory (skip if your VK / agent runner already did)
mkdir -p ~/workspace/PROJ-1234
cd ~/workspace/PROJ-1234

# 3. Create worktrees for the repos you'll modify
git -C ~/repos/sandbox worktree add ~/workspace/PROJ-1234/sandbox feature/PROJ-1234

# 4. Make your code changes
cd ~/workspace/PROJ-1234/sandbox
# ... edit files ...
git add . && git commit -m "WIP"

# 5. Start the sandbox
cd ~/workspace/sandbox
./sandbox up PROJ-1234

# 6. Set the feature in your browser
# Visit https://frontend.local.sandbox.com/__sandbox and enter "PROJ-1234"

# 7. Develop and iterate
./sandbox logs PROJ-1234
./sandbox restart PROJ-1234  # after code changes if hot-reload doesn't work

# 8. Tear down when done
./sandbox down PROJ-1234
```

### Adding a Service Mid-Development

If you started with just `frontend` but now need `backend` running locally:

```bash
# Check what's currently running
./sandbox services PROJ-1234

# Add backend locally
./sandbox up PROJ-1234 -s backend

# Verify
./sandbox services PROJ-1234
```

### Running Multiple Features Simultaneously

Each feature is fully isolated. Just `sandbox up` each one:

```bash
./sandbox up PROJ-1234    # Gets slot 1
./sandbox up PROJ-5678    # Gets slot 2
./sandbox up PROJ-9012    # Gets slot 3

# Check all features
./sandbox status

# Switch between features in the browser via the feature selector UI
# Or use different browser profiles, each with a different X-Feature cookie
#
# Easiest: open a dedicated, isolated window per feature with the cookie
# already set and the window tagged [feature] in its title + a corner badge:
./sandbox open PROJ-1234
./sandbox open PROJ-5678 --path /categories/crm
```

### Running Playwright Tests

```bash
# Make sure the feature is running
./sandbox up PROJ-1234

# Run all Playwright tests
./sandbox test PROJ-1234

# Run a specific test file
./sandbox test PROJ-1234 -- tests/checkout.spec.ts

# Run in headed mode for debugging
./sandbox test PROJ-1234 -- --headed --debug
```

The test command sets `SANDBOX_FEATURE` and `SANDBOX_SLOT` in the Playwright process environment. Your Playwright config can use these to set the `X-Feature` header on all requests.

### Debugging a Service

```bash
# Tail logs for a specific service
./sandbox logs PROJ-1234 frontend

# Check service endpoints
./sandbox services PROJ-1234

# Access the service directly (bypassing Caddy)
curl http://localhost:11101/  # frontend at slot 1, offset 1

# Access via Caddy with feature header
curl -H "X-Feature: PROJ-1234" https://frontend.local.sandbox.com/

# Check container status
./sandbox status -v

# Restart after fixing
./sandbox restart PROJ-1234
```

---

## Troubleshooting

### "No available slots" Error

All 12 slots are occupied. Free one by stopping a feature:

```bash
./sandbox status          # See which features are active
./sandbox down old-feature  # Free up a slot
```

### k8s Port-Forwards Are Down

```bash
# Check container status
./sandbox k8s-status

# View port-forward logs
docker logs sandbox-k8s-forwards

# Restart the k8s-forwards container
docker compose -f infra/compose/shared-infra.yml restart k8s-forwards

# Verify kubectl context (used inside the container)
kubectl config current-context
kubectl cluster-info
```

### Containers Won't Start

```bash
# Check the generated compose file (lives at the feature's workspace root)
cat ~/workspace/PROJ-1234/docker-compose.yml

# Try starting manually for more verbose output
docker compose -f ~/workspace/PROJ-1234/docker-compose.yml up

# Check container logs
docker compose -f ~/workspace/PROJ-1234/docker-compose.yml logs

# Verify workspace exists
ls ~/workspace/PROJ-1234/
```

### Feature Not Routing Correctly

```bash
# Verify the Caddyfile includes your feature
cat infra/proxy/Caddyfile | grep -A 5 "PROJ-1234"

# Regenerate and reload
./sandbox proxy-reload

# Test with explicit header
curl -v -H "X-Feature: PROJ-1234" https://frontend.local.sandbox.com/

# Check Caddy is running
docker compose -f infra/compose/shared-infra.yml ps caddy
```

### Services Not Auto-Detected

```bash
# Run detection manually
./sandbox detect PROJ-1234

# Check that the workspace has committed changes
cd ~/workspace/PROJ-1234/sandbox
git diff main..HEAD --name-only

# Verify repo name matches config
grep -A 3 "repos:" infra/config/services.yaml

# Force-add a service manually
./sandbox up PROJ-1234 -s frontend
```

### Build/Dependency Errors

```bash
# Reinstall dependencies and rebuild the CLI
rm -rf node_modules apps/cli/dist
npm install
npm --prefix apps/cli run build
./sandbox --help

# Check the node version — must be 20+
node --version

# ./sandbox picks a runtime: SANDBOX_NODE, then PATH, then the newest nvm
# install. Pin it explicitly if the wrong one is found:
SANDBOX_NODE=/opt/homebrew/bin/node ./sandbox --help

# Update a dependency
#   1. Edit the version in apps/cli/package.json
#   2. npm install   # re-resolve and update package-lock.json
#   3. npm --prefix apps/cli run build
```

> `sandbox hooks gate` deliberately bypasses the CLI import chain via
> `dist/lib/gate.js` for a fast PreToolUse cold start — if the gate misbehaves,
> confirm `dist/` is built before debugging further.

### Stale Slot Data

If `~/.sandbox/slots.json` gets out of sync (e.g., containers were removed manually):

```bash
# View current slot data
cat ~/.sandbox/slots.json | jq .

# Reset by running down on stale features
./sandbox down stale-feature

# Or manually edit the file
# (delete entries for features that no longer exist)
```

---

## Architecture Diagram

```
                    Docker network: sandbox-shared
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Browser / Playwright / curl                                   │  │
│  │  Cookie: X-Feature=PROJ-1234                                    │  │
│  └───────────────────────┬────────────────────────────────────────┘  │
│                          │                                           │
│                          ▼                                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Caddy (HTTPS :443)                                          │    │
│  │  frontend.local.sandbox.com                              │    │
│  │                                                               │    │
│  │  1. Terminate HTTPS                                           │    │
│  │  2. Serve feature selector UI (/__sandbox)                     │    │
│  │  3. Read X-Feature cookie/header                              │    │
│  │  4. Route to feature's local containers (if running)          │    │
│  │  5. Fall back to k8s baseline (via k8s-forwards)              │    │
│  └──────────┬───────────────────────────┬────────────────────────┘    │
│             │                           │                            │
│      ┌──────▼──────┐            ┌───────▼───────┐                    │
│      │  Local       │            │  k8s-forwards  │                    │
│      │  Containers  │            │  (container)   │                    │
│      │              │            │                │                    │
│      │  Feature A:  │            │  :9000-9008    │                    │
│      │  frontend, │            │  (apps)        │                    │
│      │  fed-graph   │            │                │                    │
│      │              │            │  :9050-9052    │                    │
│      │  Feature B:  │            │  (infra)       │                    │
│      │  backend  │            │                │                    │
│      │              │            │  Shared by all │                    │
│      │  ...         │            │  features      │                    │
│      └──────────────┘            └───────┬───────┘                    │
│                                          │                            │
└──────────────────────────────────────────┼────────────────────────────┘
                                           │
                                           ▼
                                   ┌──────────────┐
                                   │  k8s Dev     │
                                   │  Cluster     │
                                   │              │
                                   │  Kubernetes  │
                                   │  Services    │
                                   └──────────────┘
```

### Per-Feature Stack

```
~/workspace/PROJ-1234/                  ← feature workspace
├── docker-compose.yml      ← Generated from infra/templates/
├── .env                    ← Service URLs, DB connections
└── .sandbox/
    └── supergraph-config.yml   ← Apollo Federation routing

Docker Network: sandbox-PROJ-1234 (isolated)

Containers:
├── sandbox-PROJ-1234-backend     (:11100 → :3000)
└── sandbox-PROJ-1234-frontend     (:11101 → :3000)
```

### Lifecycle Flow

```
sandbox up PROJ-1234
    │
    ├── 1. Scan workspace (~/workspace/PROJ-1234/)
    │       └── git diff main..HEAD in each repo
    │
    ├── 2. Allocate slot → ~/.sandbox/slots.json
    │
    ├── 3. Generate files → ~/workspace/PROJ-1234/
    │       ├── docker-compose.yml      (from infra/templates/)
    │       ├── .env                    (from infra/templates/)
    │       └── .sandbox/supergraph-config.yml
    │
    ├── 4. Verify k8s forwards → sandbox k8s-status
    │
    ├── 5. Start containers → docker compose up -d
    │
    └── 6. Update proxy → infra/proxy/Caddyfile → caddy reload
```
