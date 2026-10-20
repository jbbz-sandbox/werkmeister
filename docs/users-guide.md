# Werkmeister — User's Guide

> Multi-feature concurrent development environment (formerly `sandbox`; the CLI is `werkmeister`, or `w9r` for short; the old `sandbox` command is deprecated).
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
   - [Which services run locally](#which-services-run-locally)
5. [Getting Started](#getting-started)
6. [CLI Reference](#cli-reference)
   - [werkmeister up](#werkmeister-up)
   - [werkmeister down](#werkmeister-down)
   - [werkmeister restart](#werkmeister-restart)
   - [werkmeister status](#werkmeister-status)
   - [werkmeister detect](#werkmeister-detect)
   - [werkmeister services](#werkmeister-services)
   - [werkmeister logs](#werkmeister-logs)
   - [werkmeister remove](#werkmeister-remove)
   - [werkmeister test](#werkmeister-test)
   - [werkmeister intercept](#werkmeister-intercept)
   - [werkmeister k8s-connect](#werkmeister-k8s-connect)
   - [werkmeister k8s-status](#werkmeister-k8s-status)
   - [werkmeister proxy-reload](#werkmeister-proxy-reload)
7. [Services Reference](#services-reference)
   - [Application Services](#application-services)
   - [Infrastructure Services](#infrastructure-services)
   - [Setup Services](#setup-services)
8. [Port Allocation](#port-allocation)
   - [Feature Slot Ports](#feature-slot-ports)
   - [k8s Forward Ports](#k8s-forward-ports)
9. [Configuration Files](#configuration-files)
   - [~/.werkmeister/services.yaml (generated)](#werkmeisterservicesyaml-generated)
   - [infra/config/ports.yaml](#infraconfigportsyaml)
   - [k8s forward table (in services.yaml)](#k8s-forward-table-in-servicesyaml)
   - [Optional integrations](#optional-integrations)
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

Werkmeister is a CLI-driven orchestration layer that enables concurrent feature development across the target app's distributed architecture (~15 services across ~9 repos). Instead of running all services locally, each feature runs **only the services with code changes** in Docker containers, while everything else is transparently served from k8s via containerized `kubectl port-forward` processes.

A Caddy reverse proxy terminates HTTPS, serves the feature selector UI, and routes each service's public hostname directly. It reads an `X-Feature` cookie or header from incoming requests and routes them to the correct feature's local containers — or falls back to the k8s baseline for services that aren't running locally.

**Key benefits:**

- **Low memory footprint** — a typical feature uses 512MB–1GB (3 local services) instead of 12GB+ for the full stack
- **Feature isolation** — each feature gets its own Docker network, port range, and compose stack; no cross-contamination
- **Auto-detection** — `werkmeister up` analyzes your git changes to determine which services to run
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

### Workspace Directory

Werkmeister supports two workspace layouts:

**Standalone layout** (default) — repos checked out flat in `~/workspace/`:

```
~/workspace/
└── werkmeister/        # standard git clone
```

Feature names are arbitrary labels (not directory names). Override the default path with `--workspace` or the `WORKSPACE` env var.

**Multi-feature layout** — per-feature workspace nesting (one parent dir, one subdir per feature, repo worktrees under each). Activated by setting `SANDBOX_WORKSPACES_ROOT` and laying out subdirectories like:

```
~/workspace/         # set SANDBOX_WORKSPACES_ROOT to this
├── feature-abc/
│   └── werkmeister/    # git worktree of the werkmeister repo
├── feature-xyz/
│   └── werkmeister/
└── ...
```

In this layout each feature maps to a subdirectory containing its repo worktrees. This layout is what Vibe Kanban's automation produces by default, but Werkmeister itself is layout-agnostic — any directory with worktrees under `SANDBOX_WORKSPACES_ROOT/<feature>/` works.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/jbbz-sandbox/werkmeister.git
cd werkmeister

# Build the CLI once, then run it:
npm install
npm --prefix apps/cli run build

# apps/cli/werkmeister resolves a node runtime (SANDBOX_NODE -> PATH -> newest nvm)
# and execs apps/cli/dist/main.js.
apps/cli/werkmeister --help
```

After the initial build, `apps/cli/werkmeister` is self-contained — it resolves a node runtime and execs the compiled CLI. Rebuild (`npm --prefix apps/cli run build`) after pulling changes to `apps/cli/src/`.

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

By default, Werkmeister looks for repos in `~/workspace/`. Override with `--workspace`, the legacy `WORKSPACE` env var, or `SANDBOX_WORKSPACES_ROOT` (preferred) for per-feature workspace nesting.

**Resolution priority** (see `resolve_workspace` in `apps/cli/src/lib/config.ts`):
1. `--workspace` flag (explicit path)
2. `SANDBOX_WORKSPACES_ROOT` env var (preferred)
3. `SANDBOX_WORKSPACE_ROOT` env var (deprecated alias — removed in v2)
4. `WORKSPACE` env var (legacy alias, kept for back-compat)
5. Auto-detect from the current directory — walk up to the nearest `.git` boundary and use its parent, so you can run `werkmeister` from inside a repo/worktree
6. `~/workspace/` (fallback)

When you run `werkmeister up my-feature`, the CLI:
1. Resolves the workspace directory (default: `~/workspace/`, or per the priority above)
2. Finds repo directories that match entries in `infra/config/services.yaml`
3. Runs `git diff main..HEAD --name-only` in each to find changed files
4. Maps changed files to services using `infra/config/services.yaml`
5. Starts only those services locally

### Initializing a Workspace

`werkmeister init-workspace` writes the per-feature `CLAUDE.md` and `.env` into the workspace root. Each input resolves in this order (first non-empty wins):

1. **CLI flag** — `--feature`, `--services`, `--issue-id`, `--test-path`, `--description`, `--task`
2. **`SANDBOX_*` env var** — `SANDBOX_SERVICES`, `SANDBOX_ISSUE_ID`, `SANDBOX_TEST_PATH`, `SANDBOX_DESCRIPTION`, `SANDBOX_TASK`. `SANDBOX_FEATURE` is not an input: every workspace container exports it as its own feature name. Every `SANDBOX_*` variable the tool reads also accepts a `WERKMEISTER_*` name, which wins when both are set; the names the tool exports (`env.sh`, compose, container env) are still `SANDBOX_*`.
3. **Config file** — `<workspace>/.werkmeister/workspace.yml` (override with `--config <path>` or `SANDBOX_WORKSPACE_CONFIG`; legacy `workspace.jsonc` / `workspace.json` are still read)
4. **Stdin / defaults** — piped stdin or a slug-derived hint from the workspace directory name (for `task`)

```bash
werkmeister init-workspace \
    --feature blog \
    --services frontend,backend \
    --issue-id <ref>
```

`<ref>` is an issue ID in the tracker `werkmeister setup` picked; it is stored as `issue_id` in
`.werkmeister/workspace.yml`.

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

Where `port_offset` is defined per service in `~/.werkmeister/services.yaml` (in the demo registry: backend = 0, frontend = 1).

Slot assignments are persisted in `~/.werkmeister/slots.json` and survive terminal restarts.

### k8s Port-Forwards (Baseline)

All services are available from k8s on a fixed port range (9000–9099), shared across all features. These are the "baseline" — when a feature doesn't run a service locally, requests are routed to the k8s forward.

k8s port-forwards now run inside a Docker container (`k8s-forwards`) as part of shared infrastructure (`infra/compose/shared-infra.yml`). They are accessible via the Docker DNS name `k8s-forwards` on the `sandbox-shared` network.

| Port | Service | k8s Namespace |
|---|---|---|
| 9050 | redis | default |
| 9051 | postgres | default |
| 9052 | backend | default |
| 9053 | frontend | default |

These ports are internal to the Docker network — other containers reach them via `k8s-forwards:9xxx`. k8s forwards must be running before starting features. Start them with `werkmeister connect`.

### Caddy Reverse Proxy

Caddy runs as a Docker container (ports 80 and 443) and provides:

1. **HTTPS termination** — Caddy terminates HTTPS on port 443 using locally-trusted certificates
2. **Feature selector UI** — a web page at `https://frontend.local.sandbox.com/__werkmeister` for setting the active feature in your browser
3. **Feature resolution** — Caddy matches the `X-Feature` cookie and reverse-proxies to that feature's local container, falling back to the k8s baseline when the service isn't running locally
4. **Per-service hostnames** — each routed service gets its own hostname derived from `ingress.local_domain` (e.g., `frontend.local.sandbox.com`)

The Caddyfile is regenerated automatically whenever you run `werkmeister up`, `werkmeister down`, `werkmeister remove`, or `werkmeister proxy-reload`.

### Which services run locally

`werkmeister up` runs the services listed in the workspace's `.werkmeister/workspace.yml` `services:` key (or passed with `-s`). Everything else is reached in the cluster through the k8s-forwards tunnels.

### Concurrency & Isolation

Each feature runs in an isolated environment:

- **Docker networks** — each feature gets its own bridge network (`sandbox-<feature>`)
- **Container names** — prefixed with the feature name (`<feature>-<service>`)
- **Named volumes** — `node_modules`, build caches, and other named volumes are prefixed with the feature name (e.g., `my-feature-frontend_node_modules`) so concurrent features never share mutable state
- **Port ranges** — each feature's slot maps to a dedicated host port range (see [Slots & Port Ranges](#slots--port-ranges))
- **Generated files** — each feature's `compose.yml` and `.env` are written to its workspace root, and, when the registry has a GraphQL subgraph, `supergraph-config.yml` to `<workspace>/.werkmeister/`

**Single-repo concurrency note:** In single-repo mode (`~/workspace/` with one checkout per repo), all features share the same source code checkout. This means two features modifying the same repo will see each other's uncommitted changes. For true concurrent multi-feature development, use the per-feature workspace layout via `SANDBOX_WORKSPACES_ROOT=<parent>` and place git worktrees under each feature subdir.

---

## Getting Started

### Step 1: Start Shared Infrastructure

Start all shared infrastructure (k8s-forwards, jaeger, redisinsight, caddy):

```bash
werkmeister connect
```

Verify k8s forwards are healthy:

```bash
werkmeister k8s-status
```

### Step 2: Configure Local DNS

Add to `/etc/hosts`:

```
127.0.0.1 frontend.local.sandbox.com
```

### Step 3: Start a Feature

```bash
# Auto-detect and start services (scans ~/workspace/ by default)
werkmeister up my-feature

# Or point to a different repo directory
werkmeister up my-feature --workspace /path/to/repos

# Run another service locally: add it to `services` in .werkmeister/workspace.yml, then
werkmeister init-workspace
werkmeister up my-feature
```

A workspace with no services still comes up; all its traffic goes to k8s.

### Step 5: Access Your Feature

**Option A: Browser cookie**
Visit `https://frontend.local.sandbox.com/__werkmeister`, type your feature name, and click "Set Feature". All subsequent requests in that browser will be routed to your feature.

**Option B: HTTP header**
Use a browser extension or curl:
```bash
curl -H "X-Feature: my-feature" https://frontend.local.sandbox.com/
```

### Step 6: View Status

```bash
werkmeister status
```

### Step 7: Tear Down

```bash
werkmeister down my-feature
```

---

## Creating a workspace

Every entry point — `werkmeister workspace`, `--browser-form`, the MCP `workspace` /
`create-workspace` tools, and the /workspaces pane — runs the same `createWorkspace`.
With an issue ID it fetches the issue (failing if it can't), stores it in
`.werkmeister/issue.md`, fills the task from the title, and rewrites the issue into a
description and starting prompt for any you left empty (`--no-distill` to skip).
Both context strategies show the issue in CLAUDE.md and the brief.

The copy is frozen at creation. To update it: `werkmeister init-workspace --refresh-issue`
(the brief is not rewritten, except one that is still the untouched placeholder, which is rebuilt from the issue). `werkmeister connect` reports whether this machine can read
the issue tracker and, on a terminal, offers `gh auth login`.

---

## CLI Reference

All commands are invoked as `werkmeister` (or `w9r`), which `npm link -w apps/cli` or a global install puts on your PATH; from a bare checkout use the `apps/cli/werkmeister` wrapper script. The examples below write `werkmeister`. Run `werkmeister --help` for a list of commands, or `werkmeister <command> --help` for command-specific help. The old `sandbox` command still works but is deprecated.

### Debugging

Set the `SANDBOX_DEBUG` environment variable to get full stack traces on errors:

```bash
SANDBOX_DEBUG=1 werkmeister up my-feature
```

---

### werkmeister up

**Start a feature's local development environment.**

```
werkmeister up <feature> [--workspace <path>]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name (arbitrary label for slot allocation and proxy routing) |
| `--workspace`, `-w` | No | Path to directory containing repo checkouts. Default: `~/workspace/`. Also settable via `WORKSPACE` env var. |

The local services come from the workspace's `.werkmeister/workspace.yml` (via `werkmeister init-workspace`), not from a flag.

**What it does:**

1. Loads service registry and port configuration
2. Resolves the workspace (default: `~/workspace/`) and reads its local services from the `SERVICES=` line `werkmeister init-workspace` wrote to the workspace `.env`
3. Allocates a slot (1–12) if the feature doesn't already have one
4. Generates per-feature files in the feature's workspace:
   - `compose.yml` — Docker Compose stack definition (workspace root)
   - `.env` — Environment variables with resolved service URLs (workspace root)
   - `<workspace>/.werkmeister/supergraph-config.yml` — GraphQL federation config (only when a service has a GraphQL type: `graphql-subgraph`, `graphql`, `subgraph` or `federation`)
5. Verifies k8s port-forwards are healthy (restarts if needed)
6. Starts containers with `docker compose up -d --build --remove-orphans`
7. Regenerates `~/.werkmeister/infra/proxy/Caddyfile` and reloads Caddy

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

**If the workspace lists no services**, the command still proceeds — the feature is registered and routes entirely to k8s. To add services later, list them in `.werkmeister/workspace.yml`, rerun `werkmeister init-workspace`, then `werkmeister up`.

**If all 12 slots are occupied**, the command exits with an error. Free a slot by running `werkmeister down` on another feature.

---

### werkmeister down

**Stop a feature and release its resources.**

```
werkmeister down <feature> [--volumes]
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
The feature's generated files (`compose.yml`, `.env`, `.werkmeister/`) are left in place in its workspace — they're overwritten on the next `werkmeister up`.

By default, per-feature Docker volumes (node_modules, build caches) are preserved so the next `werkmeister up` is faster. Use `--volumes` to remove them for a full cleanup.

The command is safe to run even if the feature is already stopped — it will clean up any leftover state.

---

### werkmeister restart

**Restart a feature's containers without regenerating config.**

```
werkmeister restart <feature>
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |

Useful after making code changes that hot-reload doesn't pick up. If the feature doesn't have a slot, prints an error suggesting `werkmeister up` instead.

---

### werkmeister status

**Show all active features and their status.**

```
werkmeister status [-v]
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

### werkmeister detect

**Generate a repo's `.sandbox/services.yaml` from what the repo already contains.**

```
werkmeister detect [repo] [--dry-run] [--yes] [--assist | --no-assist]
```

| Argument | Description |
|---|---|
| `repo` | Repo directory. Default: the git repo containing the current directory. |
| `--dry-run` | Print the report and the proposed YAML; write nothing. |
| `--yes`, `-y` | Write without asking. |
| `--assist` / `--no-assist` | Ask Claude about the fields the scan had to guess, or never ask. Without either flag an interactive run asks first (default no), and a non-interactive run never asks. |

It reads `package.json` and workspaces (npm, pnpm, yarn), Dockerfiles, docker-compose files, Helm charts (rendered with `helm template`), raw k8s manifests and kustomize overlays (`kubectl kustomize`). For each value the report shows where it came from, and every guess is marked. Guesses are written with a `# guessed:` comment, so they're easy to find and fix.

`port_offset` is picked from the offsets no other repo under `paths.repos_root` uses. Infrastructure (redis, postgres and other datastores) gets the next free `k8s_forward_port` from 9050.

Re-running only adds services and keys the file doesn't have yet. Nothing already in the file changes: not values, comments or formatting. After writing, run `werkmeister registry sync`.

`--assist` runs one read-only Claude session (Read, Glob and Grep only) over the repo. It only answers the listed questions: a non-Node service's dev command, health path, environment, secrets, `depends_on`, and which service an unmatched Deployment belongs to. Answers are written with `# inferred by Claude:` and never replace a value the scan read from a file.


---

### werkmeister services

**List service endpoints for a running feature.**

```
werkmeister services <feature>
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

### werkmeister logs

**Tail Docker Compose logs for a feature.**

```
werkmeister logs <feature> [service]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| `service` | No | Specific service to tail (omit for all services) |

Streams logs in real-time (equivalent to `docker compose logs -f --tail 100`). Press `Ctrl+C` to stop.

```bash
# All services
werkmeister logs my-feature

# Just frontend
werkmeister logs my-feature frontend
```

---

### Adding a service to a running feature

There is no `werkmeister add` command, and `werkmeister up` takes no service list. To run a
service locally, add it to the `services` field in the workspace's
`.werkmeister/workspace.yml`, rerun `werkmeister init-workspace` — this also adds the owning
repo's worktree if it isn't present yet — then `werkmeister up`.

---

### werkmeister remove

**Remove a local service, falling back to k8s.**

```
werkmeister remove <feature> <service>
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| `service` | Yes | Service name |

Removes the service from the feature's local stack. The service will now be served from k8s. Config files are regenerated and Caddy is reloaded.

If removing the last service, the feature's containers are fully stopped (though the slot remains allocated — use `werkmeister down` to release it).

```bash
werkmeister remove my-feature frontend
```

---

### werkmeister test

**Run Playwright tests against a feature.**

```
werkmeister test <feature> [-- extra-args...]
```

| Argument | Required | Description |
|---|---|---|
| `feature` | Yes | Feature name |
| extra args | No | Additional arguments passed to `npx playwright test` |

**What it does:**

1. Looks for a `playwright.config.ts` (or `.js`/`.mjs`) in the workspace root, then in each repo worktree under it (`~/workspace/<feature>/<repo>/`). There is no fallback to the Werkmeister root.
2. If none is found, runs nothing and exits non-zero. The message lists each workspace service's test command and `validate:` guidance. Libraries, CLIs and extensions are validated that way, not with Playwright; see [Test commands and validation guidance](#test-commands-and-validation-guidance).
3. Otherwise sets `SANDBOX_FEATURE` and `SANDBOX_SLOT` for the Playwright process and runs `npx playwright test` from that directory with a 10-minute timeout

```bash
# Run all tests
werkmeister test my-feature

# Run specific test file
werkmeister test my-feature -- tests/homepage.spec.ts

# Run with headed browser
werkmeister test my-feature -- --headed
```

The feature doesn't need to have an active slot — if it doesn't, the command warns but proceeds with just the feature header routing.

---

### werkmeister intercept

**Route a header-scoped slice of live cluster traffic to your local container.**

```
werkmeister intercept <feature> -s <service> [--docker-daemon]
werkmeister intercept <feature> --leave [-s <service>]
werkmeister intercept --status
```

| Argument | Required | Description |
|---|---|---|
| `feature` | No | Feature name. Falls back to `FEATURE` in a `.env` file in the current directory tree |
| `-s, --service` | Yes (to start) | Local service to intercept. Must be in the workspace's `SERVICES` and already running via `werkmeister up` |
| `--leave` | No | End the intercept for `-s`, or all of this feature's intercepts without it |
| `--status` | No | Show the telepresence connection and active intercepts |
| `--docker-daemon` | No | Run the telepresence daemon in a container instead of on the host — see below |

Only requests carrying `x-feature: <feature>` are rerouted; teammates and baseline dev
traffic reach the cluster workload untouched. The intercept target is the container
`werkmeister up` already published on the feature's slot port, so hot reload keeps working.

**Two daemon modes.** Telepresence has to get cluster traffic onto your laptop, and there
are two places its daemon can live. [docs/topology.md](topology.md) draws the whole picture,
including what changes when the cluster is a managed one in the cloud.

| | host mode (default) | `--docker-daemon` |
|---|---|---|
| Asks for your password | **Yes** — root creates a TUN device, writes `/etc/resolver/*`, adds routes | **No** |
| Cluster DNS on the host (`backend.default` resolves in your shell) | Yes | **No** |
| VPN routing conflicts | Possible — both want the routing table | Avoided |
| Requires a working Docker | Only for your services | Yes, for the daemon too |

The password prompt is telepresence's own `sudo`, not Werkmeister's. It comes once per root
daemon lifetime — until `telepresence quit -s` or a reboot — not once per intercept.

Pick host mode when you want to `curl backend.default` or point host-side tooling at cluster
names. Pick `--docker-daemon` when the password prompt or a VPN is in your way, and accept
that cluster names resolve nowhere on the host while it is connected. Traffic flowing
cluster → laptop, which is what an intercept is for, behaves identically in both.

Switching modes means dropping the current daemon first:

```bash
telepresence quit -s
werkmeister intercept my-feature -s backend --docker-daemon
```

**On OrbStack** (the default `k8s_context`), docker mode works with no extra configuration.
Two details, both verified live rather than assumed:

- The kubeconfig points at `https://127.0.0.1:26443`, which inside a container would be the
  container itself. Telepresence ≥ 2.31 rewrites it to `host.docker.internal` on its own,
  and OrbStack's API certificate already covers that name — so `connect --docker` needs no
  `--server` override.
- The intercept does need `--address host.docker.internal`, which the CLI passes for you.
  Without it telepresence forwards to `127.0.0.1` *inside the daemon container*, and the
  cluster's request dies as `{"error":"EOF"}` while your local container sits idle.

```bash
# Start the feature first (with backend in workspace.yml's services) — the local container is the intercept target
werkmeister up my-feature
werkmeister intercept my-feature -s backend --docker-daemon

# From inside the cluster: the header reaches your laptop, bare traffic does not
kubectl run probe --rm -i --restart=Never --image=curlimages/curl:latest --quiet -- \
  curl -s -H "x-feature: my-feature" http://backend.default/

werkmeister intercept my-feature --leave -s backend
```

A service can only be intercepted if it declares `k8s_deployment`, `k8s_namespace` and
`k8s_port` in the registry; `werkmeister status --intercepts` reports what is interceptable and
what is currently intercepted.

---

### werkmeister k8s-connect

**Start or check the containerized k8s port-forwards.**

```
werkmeister k8s-connect
```

No arguments. Starts the `k8s-forwards` Docker container (part of `infra/compose/shared-infra.yml`) which runs all 12 `kubectl port-forward` processes (9 application + 3 infrastructure) inside a single container. If the container is already running, the command checks its health status.

The container runs on the `sandbox-shared` Docker network and is accessible to other containers via the DNS name `k8s-forwards`. Port-forward processes inside the container auto-restart if they disconnect, managed by the container's entrypoint script.

After starting, it runs a health check and reports the status.

```
[info] Starting k8s-forwards container...
[ok]   k8s-forwards container is healthy. 12/12 forwards active.
```

---

### werkmeister k8s-status

**Check the health of the k8s port-forwards container.**

```
werkmeister k8s-status
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
  Run 'werkmeister k8s-connect' to restart the k8s-forwards container
```

---

### werkmeister proxy-reload

**Regenerate the Caddyfile and reload Caddy.**

```
werkmeister proxy-reload
```

No arguments. Reads all active slot assignments, regenerates `~/.werkmeister/infra/proxy/Caddyfile`, and reloads (or starts) Caddy. Useful after manual config changes or if the proxy gets out of sync.

---

### werkmeister clean

**Remove orphaned Docker volumes and generated files from stopped features.**

```
werkmeister clean [--all] [--dry-run]
```

| Argument | Required | Description |
|---|---|---|
| `--all` | No | Also tear down and clean all active features |
| `--dry-run` | No | Show what would be removed without taking action |

**What it does:**

1. Identifies per-feature Docker volumes (node_modules, build caches) that belong to stopped features
2. Removes those orphaned volumes
3. Releases stale slot entries (features with no running containers or compose file)

With `--all`, it first stops all active features (equivalent to running `werkmeister down --volumes` for each), then cleans everything.

**When to use:**
- After extended development with many features started and stopped — volumes accumulate
- Before a fresh start: `werkmeister clean --all`
- To check what would be cleaned: `werkmeister clean --dry-run`

---

### Workspace lifecycle: werkmeister pr, close-out

**Open PRs from a workspace, track them to a release, then close the workspace out.** The full process — PR files, the pre-PR gate, ship detection, the PR guard — is in [workspace-lifecycle.md](workspace-lifecycle.md).

```
werkmeister pr <gate|open|status> [repo] [--json]
werkmeister close-out [name] [--yes] [--abandon <reason>]
```

| Command | Description |
|---|---|
| `werkmeister pr gate` | Run the pre-PR gate for each PR file; change nothing |
| `werkmeister pr open` | Gate, push and open a PR for each PR file at `status: approved`; record its URL |
| `werkmeister pr status` | Record merged / shipped / closed from GitHub and the repo's release tags |
| `werkmeister close-out` | The one way to end a workspace. After every PR shipped: close the issue, write `closeout.md`, remove the workspace, delete merged branches. With `--abandon "<reason>"`: record the reason, leave the issue, push every branch and keep them, remove the workspace. Lists terminal Claude sessions still open in it |
| `werkmeister remove-workspace` | Deprecated alias, kept for one release: use `werkmeister close-out --abandon` |

Inside a workspace, `gh pr create` (and so `/create-pr`) is blocked by a PreToolUse hook; `werkmeister pr open` is the way to open a PR.

---

## Cleanup & Disk Usage

Running multiple features concurrently creates per-feature Docker volumes for `node_modules` and build caches. These persist after `werkmeister down` (by design — to speed up subsequent `werkmeister up`).

**Per-feature cleanup:**
```bash
# Stop a feature and keep volumes (faster next startup)
werkmeister down my-feature

# Stop a feature and remove its volumes
werkmeister down my-feature --volumes
```

**Bulk cleanup:**
```bash
# See what's orphaned (safe — no changes)
werkmeister clean --dry-run

# Remove orphaned volumes and generated files from stopped features
werkmeister clean

# Nuclear option: tear down everything
werkmeister clean --all
```

**Manual volume inspection:**
```bash
# List all Werkmeister-related Docker volumes
docker volume ls | grep -E '^\S+-(backend|frontend)'

# Remove a specific volume
docker volume rm my-feature-frontend_node_modules
```

Each feature's volumes follow the naming pattern `<feature>-<volume_name>` (e.g., `my-feature-frontend_node_modules`). This ensures concurrent features never share mutable Docker state.

---

## Services Reference

### Application Services

The registry is `~/.werkmeister/services.yaml`, and it is **generated**: `werkmeister setup`
(or `werkmeister registry sync`) merges every `<repo>/.sandbox/services.yaml` found
under `paths.repos_root`, then applies `~/.werkmeister/services.local.yaml` on top.
Edit a repo's fragment or the local file, never the generated one. The demo
registry comes from the `demo-services` repo's own fragment:

| Service | Repo | Path in Repo | Type | Internal Port | port_offset | Health Endpoint |
|---|---|---|---|---|---|---|
| backend | demo-services | `apps/backend` | api | 3000 | 0 | /health |
| frontend | demo-services | `apps/frontend` | web | 3000 | 1 | / |

The columns above are the required keys. `werkmeister services` lists whatever is registered.

### Writing a fragment

A fragment is a slice of the registry committed at `<repo>/.sandbox/services.yaml`. `werkmeister detect` writes a first draft of this file for you; see [werkmeister detect](#werkmeister-detect).
Its JSON Schema is `apps/cli/infra/schemas/services-fragment.schema.json`. `werkmeister setup`
offers to map it (and `workspace.schema.json`) in VS Code's user `yaml.schemas` by local
path, which turns on validation through the redhat.vscode-yaml extension. Don't add a
`# yaml-language-server` modeline or a `$schema:` key: the repo is private, so the GitHub
URL 404s, and either one outranks the local mapping (the merge also rejects `$schema:` as
an unexpected top-level key):

```yaml
services:
  my-api:
    path: services/my-api         # within the repo; `.` for the whole repo
    type: api                     # api | web | library | cli | extension
    archetype: node-service       # optional; node-web | node-service | node-tool | mcp-client
    test: "npm test"
    validate: "..."               # optional; how a person or agent checks a change by hand (overrides the archetype's). See "Test commands and validation guidance"
    internal_port: 3000           # port the process listens on in-container
    port_offset: 9                # slot-relative host port; unique across ALL repos
    health_endpoint: /health      # or redis | postgres | "" (TCP-only)
    image: node:22-alpine
    command: "cd services/my-api && exec npm start"
    memory_limit: 1G
    memory_reservation: 256M
    setup_service: my-install     # optional; a key in setup_services: below
    node_modules_volume: node-modules
    feature_router: {}            # optional; opts into Caddy ingress at <service>.<local_domain>
    secrets: [MY_API_KEY]         # optional; keys werkmeister up requires in ~/.werkmeister/secrets.env
setup_services:
  my-install:
    image: node:22-alpine
    command: "npm install"
    node_modules_volume: node-modules
infrastructure: {}                # cluster-forwarded datastores this repo needs (see demo-services)
```

Rules:
- Only `services:`, `setup_services:` and `infrastructure:` may appear. `repo:` is the
  checkout's directory name and `repos:` is derived from each service's `path`.
- `{{home}}`, `{{repos_root}}` and `{{workspaces_root}}` expand from the developer's
  `config.yaml`; use them instead of absolute paths in `extra_volumes:` and `environment:`.
- A `secrets:` key resolves from the workspace's `.werkmeister/workspace.yml` `env_vars:` first,
  then `~/.werkmeister/secrets.env` as `<SERVICE>__KEY` (service name uppercased, `-` → `_`,
  e.g. `MY_API__MY_API_KEY`), then plain `KEY`. A value from `secrets.env` reaches only
  that service, as plain `KEY`, through the git-ignored `<workspace>/.env.<service>`; the
  shared workspace `.env` holds no secrets. An `env_vars:` value also sits in that shared
  `.env`, so every service sees it, and `env_vars:` keys are never namespaced. Namespaced
  keys no service declares (e.g. test logins for agents) reach no container.
- `x-` keys are dropped from the output and exist to hold YAML anchors.
- A duplicate service name, `port_offset` or `k8s_forward_port` across two repos fails the
  merge naming both. `werkmeister registry --check` reports drift.
- Helm charts (`charts/*.values.yaml`) give you `internal_port` (`containerPort`),
  `health_endpoint` (`probePath`) and `k8s_port` (`service.port`); the dev `image`,
  `command`, `port_offset` and the Werkmeister-side `environment` are yours to decide.

Per-machine values (`k8s_context`, a bigger `memory_limit` on your laptop) go in
`~/.werkmeister/services.local.yaml`, which merges last.

### Test commands and validation guidance

Each service can carry two related keys. They do different jobs, and a change needs both.

| | `test:` | `validate:` |
|---|---|---|
| What it is | A shell command, e.g. `npx turbo run test --filter=werkmeister-core` | Plain-language instructions, e.g. "Build, then run the built binary against a temp fixture workspace; assert on exit code, stdout/stderr and the files it writes." Never executed. |
| Who uses it | Tooling: the implement stage's test step, `werkmeister pr gate`, `werkmeister test`'s fallback message | Whoever exercises the change: an agent in the implement stage, or you |
| Question it answers | Do the automated tests still pass? | Does the change actually do what was asked, seen from outside? |
| Evidence it leaves | The exit code and summary line | A `\| check \| result \|` table of PASS/FAIL rows with the captured output (`exercise.md`) |

**How each is resolved.** A service's own value wins over its archetype's. A `test:` template from an archetype has `{service}` replaced by the service name. When neither is set:

| Missing | What shows up |
|---|---|
| `test:` | The How to validate table shows `—`. The gate fails `test <service>` unless the PR file sets `skip_tests: { <service>: <reason> }`, which is accepted for a service with no test command or no running container. |
| `validate:`, service has a `feature_router:` | "URL health check (see Quick Health Checks)": the proxy, cookie and health-check sections of `sandbox-context.md` are the validation. |
| `validate:`, no `feature_router:` | "No validation guidance registered in services.yaml; say so instead of inventing one". Add a `validate:` value rather than leave agents to guess. |

The shipped archetypes give `node-tool` (libraries) and `mcp-client` (editor extensions) a default `validate:`. A CLI service sets its own, because "run the unit tests" doesn't show that a command does the right thing.

**Where each is used, in order:**

1. **`.werkmeister/sandbox-context.md`.** The first section, "How to validate", has one row per workspace service: repo, path, test command, validation. Both keys are read from here, not from the registry directly.
2. **Implement stage (ICM)**, or the test phase in JIT (`sb-test` and the tester agents):
   - The **test step** runs each touched service's test command exactly as `sandbox-context.md` states it.
   - The **exercise step** reloads the running code, then checks the change the way the service's validation text says. It records the result in `output/exercise.md` as a `| check | result |` table.
   - `test:` catches regressions; `validate:` shows the new behaviour works. Passing tests are not a substitute for the exercise.
3. **PR gate** (`werkmeister pr gate`, re-run by `werkmeister pr open`):
   - It re-runs `test:` for every service the branch touches, inside a running container of that repo, so the workspace needs one up (`werkmeister up`).
   - It doesn't read `validate:` itself. It checks the exercise evidence: the exercise table must have at least one PASS row and no FAIL row. An ICM workspace keeps it in `stages/*/output/exercise.md` (`verify.md` in workspaces made before the rename); JIT keeps it in `.werkmeister/notes/exercise.md`.
4. **`werkmeister test`** runs the Playwright suite if the workspace or one of its repos has one. With no suite, it runs nothing and prints each service's test command and validation text instead, since libraries, CLIs and extensions are checked that way.

**Writing a good `validate:` value:**
- Say what to run and what to observe: a command and the output, files or UI state that proves the change, not "verify it works".
- Don't repeat the test command; `test:` already covers that.
- Name any manual list a person has to walk, e.g. `MANUAL-CHECKLIST.md` for the VS Code extension.
- Keep it to a sentence or two. It shows in a table cell and in tester-agent prompts.

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
| _(none)_ | — | — | — | The demo registry defines no setup services. Add them under `setup_services:` in `~/.werkmeister/services.yaml` for monorepos that need a shared install/build step before their services start. |

Setup services are automatically included in generated Docker Compose files when a feature uses services from the corresponding monorepo.

### Self-hosting the Werkmeister repo

The four workspaces of this repo (`apps/cli`, `apps/sandbox-dashboard`,
`packages/sandbox-core`, `packages/vscode-plugin`) can be registered as services so a
feature workspace develops Werkmeister itself, each package in its own container. The
registry shape is the one in [Services Reference](#services-reference);
the pieces that are not obvious from the demo services:

- **One `node:22` image everywhere.** `better-sqlite3`, `keytar`, `sharp` and the
  esbuild/rollup/swc binaries ship glibc prebuilds only; alpine will not load them.
- **cli, library and extension services idle.** Their containers run `sleep infinity`
  under `init: true` with no healthcheck, so they cost almost nothing at rest and stop
  fast; the gate `docker exec`s their tests. `sandbox up --dev` (or
  `SANDBOX_DEV=1 docker compose up -d`) runs their `command:` watchers instead. The
  template still publishes a port, so a placeholder `internal_port` keeps their slot.
- **Host access for `cli` and `sandbox-dashboard`.** Those two drive the host:
  they get `/var/run/docker.sock` plus `~/.werkmeister`, `~/repos`, `~/features` and `~/.kube`
  bind-mounted at their *host* paths, `HOME` set to match, and the docker, compose and
  kubectl binaries from the per-feature `tools` volume that
  `infra/compose/scripts/sandbox-install-startup.sh` fills. The generated compose files carry
  host bind-mount paths and the daemon is the host's, so the paths must be identical on both
  sides.
- **`sandbox-install` reinstalls only when the lockfile changes.** It skips `npm ci` while
  the lockfile and Node major version match the stamp in the node_modules volume. It also
  mounts `~/repos` with git's `safe.directory`, so turbo restores the build from the main
  checkout's shared cache. Installs are queued host-wide through `~/.sandbox/locks`, at most
  `SANDBOX_INSTALL_SLOTS` (default 2) at a time. To force a reinstall, run
  `werkmeister down -v`. After upgrading, run `werkmeister registry` so the new command
  reaches `~/.werkmeister/services.yaml`.
- **`werkmeister` inside the container is the worktree's own build.** `PATH` puts
  `/app/apps/cli` first. `sandbox_root` in `~/.werkmeister/config.yaml` still points at the main
  checkout, so templates and `infra/` come from there (see the known issue on machine-global
  `sandbox_root`). **Never run `werkmeister config` or `werkmeister setup` from a worktree**, on the
  host or in the container: it silently repoints the whole machine.
- **The dashboard binds `HOST`.** It defaults to loopback for the reasons in `main.ts`; the
  registry sets `HOST=0.0.0.0` because the container network is the isolation boundary and
  Docker's published port is the only way in.
- **New hostnames need `/etc/hosts` entries.** The wildcard certificate already covers
  `*.local.sandbox.com`, but `sandbox-dashboard.local.sandbox.com` only resolves after
  `werkmeister setup` (run from the main checkout) reconciles `/etc/hosts`, which needs sudo.
  Caddy emits its site block only once a running feature declares the service.
- **The container's npm rewrites `package-lock.json`.** `node:22` ships npm 10.9.x, which
  strips the `libc` fields a newer host npm writes. Discard that diff in the worktree unless
  you actually changed dependencies.
- **Inside the container, `werkmeister status` shows every k8s forward as dead** and `kubectl`
  cannot reach OrbStack's API server: both probe `127.0.0.1`, which is the container's own
  loopback. The forwards are fine; read their state from the host. `werkmeister up`, `down`,
  `status` (for features) and `workspace` all work from inside. This applies to a container
  running the CLI *directly*. A container that calls the host MCP surface (`apps/mcp`)
  instead is unaffected: `status` runs on the host, so the forward health it reports
  is the real one.
- **Not covered:** the `gh` and `claude` binaries. Telepresence needs a daemon that owns the
  host's routing (or, with `--docker-daemon`, the Docker socket and a kubeconfig), so
  `werkmeister intercept` and `werkmeister connect` must run on the host — either from a host
  terminal, or through the `intercept` and `connect` tools on `apps/mcp`,
  which run host-side with exactly the authority a host terminal has.
- **A container can instead hold no daemon at all.** `apps/mcp` (port 3002, started by
  `werkmeister connect`) exposes twenty Werkmeister verbs over authenticated HTTP, so a container
  needs only `~/repos`, `~/features` and `SANDBOX_MCP_TOKEN` — no docker socket, no docker
  CLI, no kubectl, no `werkmeister` binary. It is the only managed web server that binds
  `0.0.0.0`, via a per-app `env` on its `WebApp` entry; never arrange that by exporting
  `HOST` before `werkmeister connect`, which would also expose the unauthenticated dashboard.
  Its `mcp_servers.werkmeister` registry entry is deliberately in no archetype — `.mcp.json` is
  shared with host sessions, where `host.docker.internal` does not resolve. See
  `apps/mcp/README.md`.
- **Wiring a service to drive Werkmeister that way** takes four edits to
  `~/.werkmeister/services.yaml`, and the granularity is the *service*, not the workspace —
  `services:` entries are machine-global, so a fresh workspace does not isolate a change.
  1. A top-level `x-mcp-client:` block **above** `services:` (YAML resolves anchors in
     document order) holding `mounts: &mcp_client_mounts` — `~/repos` and `~/features` at
     identical host paths — and `env: &mcp_client_env` — `HOME` and the `GIT_CONFIG_*`
     `safe.directory` trio. Loaders read seven top-level keys, so `x-`-prefixed ones are
     ignored. No socket, no `~/.werkmeister`, no `~/.kube`, no tools volume: the host server
     holds all of that.
  2. `extra_volumes: *mcp_client_mounts` and `environment: *mcp_client_env` on the service.
  3. An archetype of its own carrying `mcp_servers: [werkmeister]`, worn only by that service.
     Hand-adding `werkmeister` to a workspace's `.mcp.json` does **not** stick — the projection
     prunes any registry-known server the present archetypes don't want, so the next
     `init-workspace` deletes it.
  4. `SANDBOX_MCP_TOKEN` in `~/.werkmeister/secrets.env` (copy `~/.werkmeister/mcp-token`) *and*
     `secrets: [SANDBOX_MCP_TOKEN]` on the service entry, which routes it through the
     service's own `.env.<service>`. Never put `${SANDBOX_MCP_TOKEN}` in the service's `environment:`:
     compose expands it from whichever shell ran it — for the `up` tool, the MCP
     server's own env, where it is unset — and `environment:` beats `env_file:`, so it
     would shadow the real value with an empty string.

  Then `werkmeister init-workspace` and `werkmeister down <feature> && werkmeister up <feature>`. To
  check it, `docker exec` into the container and POST an MCP `initialize` to
  `http://host.docker.internal:3002/mcp` with `Authorization: Bearer $SANDBOX_MCP_TOKEN`
  and `Accept: application/json, text/event-stream` — and no `Origin` header, which the
  server rejects with 403. Drive a *different* feature than the container's own: tearing
  down its own feature kills the caller mid-call.

### Running the agent itself in isolation

The four-edits recipe above wires a *compose service* that Werkmeister manages. The
same server also lets you put the whole agent — Claude Code, the editor, your shell —
somewhere isolated from the host, with port 3002 as the only bridge back. Three
shapes, in order of how much they share with the host.

**What every shape needs.** The server holds the Docker privilege, so the isolated side
needs none of the socket, `kubectl`, `~/.kube`, `~/.werkmeister` or the `werkmeister` binary.
It does need:

- `~/repos` and `~/features` mounted at their **host** paths. A worktree's `.git` is a
  file holding an absolute `gitdir:` pointer into the main checkout's `.git/worktrees/`,
  so a different mount point breaks every git command in the workspace.
- `HOME` matching the host user, and `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=safe.directory`, `GIT_CONFIG_VALUE_0=*` — the mounts arrive owned by
  a different uid.
- `SANDBOX_MCP_TOKEN` from `~/.werkmeister/mcp-token` and `FEATURE` set to the workspace's
  feature, which the projected `.mcp.json` expands into the bearer header and
  `X-Sandbox-Feature`.
- A route to the host's 3002: `host.docker.internal` resolving to the host gateway.
- The workspace's archetype carrying `mcp_servers: [werkmeister]` (edit 3 above). Nothing
  else makes the entry survive `init-workspace`.

Two things stop working on the isolated side, by design. The `werkmeister` plugin's
MCP entry runs `w9r dashboard` over stdio, and its skills shell out to the CLI; with
no binary there, use the tools the HTTP server exposes instead. And the
dashboard on 3001 is loopback-only and unauthenticated, so it is correctly unreachable.

**1. A plain container, by hand.** Nothing Werkmeister-managed; the host just has to have
run `werkmeister connect` so the server is up.

```bash
docker run -it --rm \
  -v "$HOME/repos:$HOME/repos" -v "$HOME/features:$HOME/features" \
  -e HOME="$HOME" \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  -e SANDBOX_MCP_TOKEN="$(cat ~/.werkmeister/mcp-token)" -e FEATURE=my-feature \
  --add-host host.docker.internal:host-gateway \
  -w "$HOME/features/my-feature" node:22 bash
```

Use `node:22`, not alpine, for the reason in the self-hosting list. Install `claude`
inside as you would anywhere. The smoke test is the same `initialize` POST as above.

**2. Docker Sandboxes (`docker sandbox run claude …`) or any other microVM agent runner.**
Structurally it is shape 1 with a stronger wall: the agent runs in a VM with **its own
Docker daemon**, so even a socket mount would show it an empty engine, never the host's
compose containers. Port 3002 is the only way to drive Werkmeister from inside. Two
things to check against whatever product you use, since they vary and are not verified
here: that its network policy lets the VM reach the host gateway (the server refuses
nothing but a browser `Origin`, so an allow-rule for `host.docker.internal:3002` is all
it needs), and that it can mount `~/repos` *and* `~/features` at host paths rather than
only the directory you launched it from. `docker sandbox` is a Docker Desktop feature;
on a machine whose Docker context is OrbStack or Colima it is simply absent.

**3. A full VM with its own stack.** An OrbStack Linux machine, Lima, or a cloud box
running `werkmeister setup` end to end: its own `dockerd`, Caddy, `k8s-forwards` and
telepresence, with the only shared thing a kubeconfig. The compose files already map
`host.docker.internal:host-gateway`, so plain Linux `dockerd` works unchanged. This is
the one shape that isolates you from the host's *containers* as well as its daemon, and
it is a second complete install: `~/.werkmeister`, certificates, `/etc/hosts` and all. To use
the host's browser against it, point the host's `*.local.sandbox.com` entries at the VM's
address instead of loopback, and copy the VM's CA into the browser's trust store. The
apps/mcp server is irrelevant here — the CLI runs natively inside.

Pick 1 when you want the agent off the host's Docker socket and nothing more. Pick 2
when the runner is already part of your workflow. Pick 3 only when a wrong `werkmeister
clean` or a runaway compose build must not be able to touch the host's engine at all.

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

Machine config lives in `~/.werkmeister`, and each workspace's generated state in `<workspace>/.werkmeister/`. A machine or workspace that still has `~/.sandbox` or `.sandbox/` keeps working: the old directory is read in place when the new one is missing, and nothing is moved. A repo's registry fragment is the exception: it is still `<repo>/.sandbox/services.yaml`.

### ~/.werkmeister/services.yaml (generated)

The central service registry. Defines all services, their repos, paths, ports, k8s details, and dependencies.

Generated by `werkmeister registry sync` from every `<repo>/.sandbox/services.yaml`
(see "Writing a fragment"); `archetypes:` and `mcp_servers:` come from Werkmeister's
own defaults, `repos:` is derived, and `~/.werkmeister/services.local.yaml` is merged last.

**Top-level keys:**

- **`services`** — Map of service name to service definition. Each service has:
  - `repo` (string) — Repository name (directory name in workspace)
  - `path` (string) — Path within the repo (`.` for entire repo, `apps/frontend` for monorepo packages)
  - `type` (string) — Service category: `web`, `api`, `graphql-subgraph` (also `graphql`, `subgraph`, `federation`), `graphql-gateway`
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
  - `dockerfile` (string | null) — Dockerfile in the service's `path`, built into the service's image and tagged `image:` (a local tag, never pulled)
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
`werkmeister connect` (`packages/sandbox-core/k8s_forwards.ts`) under `~/.werkmeister/infra/`:
the container's forward list is written to `k8s-port-forward/forwards` (mounted at
`/tmp/forwards`, read by `entrypoint.sh`), and the `k8s-forwards` service's
`ports:`/`aliases:` are written to `compose/k8s-forwards.override.yml`, which every
`docker compose` call the CLI makes passes as a second `-f`. The shipped
`shared-infra.yml` is never modified.
`apps/cli/src/lib/__tests__/k8s_forward_drift.test.ts` fails if the committed
`shared-infra.yml` drifts out of sync. To add or change a forward, edit only
`services.yaml` and run `werkmeister connect`.

### Optional integrations

None of these are required; each turns on only when configured.

#### Issue tracker

`werkmeister setup` asks which tracker this machine uses — `jira` (the default) or `github` —
and stores it as `overrides.issue_tracker` in `~/.werkmeister/config.yaml`. With `github`, a
workspace's issue ID is `owner/repo#n` and issues are filed in the registry repos under
`overrides.github_org`.

Issues about Werkmeister itself go to GitHub (`jbbz-sandbox/werkmeister`) unless, under
`jira`, `overrides.sandbox_issues_project` names a Jira project (e.g. `SW`): the generated
issues guide then sends them there with `werkmeister issue create`.

For Jira, set `jira.base_url` (e.g. `https://your-org.atlassian.net`) to get issue links in
CLAUDE.md, the dashboard, and VS Code. Briefings fetched through the Atlassian MCP use
`jira.cloud_id` when set, otherwise the `base_url` hostname. The REST token is optional; see
[jira-rest-setup.md](jira-rest-setup.md).

Read or update an issue in the configured tracker from the command line:

```bash
werkmeister issue view [ref] [--json]                                # print the issue (--json: as JSON)
werkmeister issue update [ref] --status <name> --comment <text>      # either option alone works too
werkmeister issue create --project <KEY> --type bug|feature|task --title <text> --body-file <path|->  # Jira: file one, print its URL
```

`create` needs the Jira REST token and maps `bug`/`feature`/`task` to Bug/Story/Task; a project
without that type gets a Task labelled with it. GitHub issues are filed with `gh issue create`.

`ref` is optional inside a workspace — it defaults to the workspace's `issue_id`. On GitHub,
`--status closed` or `done` closes the issue, `open` reopens it, and any other status is added
as a label.

#### Slack review requests

The dashboard's "Request review" button posts to Slack. Set both
`SANDBOX_REVIEW_SLACK_TOKEN` (a bot token with `chat:write`) and
`SANDBOX_REVIEW_SLACK_CHANNEL` (the channel id). Without them the button reports that Slack
is not configured.

#### GraphQL federation

When a service in the registry has a GraphQL type (`graphql-subgraph`, `graphql`, `subgraph`,
`federation`), `werkmeister up` writes
`<workspace>/.werkmeister/supergraph-config.yml` listing each subgraph's URL for your gateway.
Registries without a subgraph get no file.

---

## Generated Files

When you run `werkmeister up <feature>`, `compose.yml` and `.env` are generated at the feature's workspace root, plus `supergraph-config.yml` under `<workspace>/.werkmeister/` when the registry has a GraphQL subgraph:

### compose.yml

Workspaces generated before this name (`docker-compose.yml`) are renamed on the next `werkmeister init-workspace` or `werkmeister up`; until then `down`, `logs` and `close-out` still read the old name. The running stack is unaffected — Compose keys it by the file's `name:`, not its path.

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

Optional — generated only when a service has a GraphQL type (`graphql-subgraph`, `graphql`, `subgraph`, `federation`). Lists each subgraph with its URL for an Apollo-compatible gateway — local services point to slot ports, remote services point to k8s forwards.

---

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
- Name: `sandbox-caddy`
- Ports: 80 (HTTP), 443 (HTTPS)
- Volumes: Caddyfile (read-only), UI files, Caddy data/config
- Health check: `caddy validate --config /etc/caddy/Caddyfile`

### Feature Selector UI

Visit **`https://frontend.local.sandbox.com/__werkmeister`** in your browser to:
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
| `SANDBOX_ROOT` | CLI, all commands | Auto-detected from script location | Root path of the Werkmeister repository. Set from `~/.zshenv` (not `~/.zshrc`) so non-interactive shells (Claude Code's Bash tool, cron, MCP servers) can see it — see [docs/known-issues.md](known-issues.md#sandbox-env-vars-in-zshrc-are-invisible-to-non-interactive-shells). |
| `SANDBOX_DEBUG` | CLI dispatcher | (not set) | When set to any value, print full stack traces on errors |
| `SANDBOX_WORKSPACES_ROOT` | config, detect | `~/workspace` | Root directory containing feature workspaces. Set from `~/.zshenv` (not `~/.zshrc`) for the same non-interactive-shell reason as `SANDBOX_ROOT` above. Deprecated aliases (kept for back-compat, removed in v2): `SANDBOX_WORKSPACE_ROOT` (singular form), `WORKSPACE` (legacy), `VIBE_WORKSPACES_ROOT` (pre-VK-decoupling). |
| `SANDBOX_FEATURE` | test command, .env | (not set) | Set in the environment of Playwright test processes |
| `SANDBOX_SLOT` | test command, .env | (not set) | Set in the environment of Playwright test processes |
| `GITHUB_AUTH_TOKEN` | .env, containers | (required) | GitHub token for npm registry access |
| `POSTGRES_INSTANCE` | .env | (required) | Cloud SQL Proxy instance connection string |

---

## File Paths Reference

### Werkmeister Repository

| Path | Description |
|---|---|
| `apps/cli/werkmeister` | Launcher: resolves a node runtime and execs `dist/main.js`. `apps/cli/sandbox` (symlinked at the repo root as `./sandbox`) is the deprecated alias |
| `apps/cli/src/main.ts` | CLI dispatcher |
| `apps/cli/src/commands/` | Command modules (up, down, status, etc.) |
| `apps/cli/src/lib/` | Shared libraries (config, detect, slots, generate, docker, k8s, caddy) |
| `infra/config/services.yaml` | Service registry |
| `infra/config/ports.yaml` | Port allocation scheme |
| `infra/compose/` | Per-service base Docker Compose fragments |
| `infra/compose/k8s-port-forward/` | Dockerfile and entrypoint for containerized k8s port-forwards |
| `infra/templates/` | nunjucks templates for per-feature file generation |
| `infra/compose/shared-infra.yml` | Shared infrastructure (k8s-forwards, jaeger, redisinsight, caddy) |
| `~/.werkmeister/infra/proxy/Caddyfile` | Generated Caddy config (never inside the package) |
| `infra/proxy/ui/index.html` | Feature selector web UI |
| `apps/graphql-tools/` & `apps/otel-init/` | Node.js tooling (now an npm-workspaces monorepo with a root `package.json` + single root `package-lock.json`): GraphQL extract/validate scripts and `apps/graphql-tools/queries/` in `apps/graphql-tools/`, OTel source in `apps/otel-init/` |
| `bin/` | Setup helper scripts (authenticate, generate-certs, generate-env, ...) |
| `apps/cli/dist/` | Compiled CLI (`tsc` output; `apps/cli/werkmeister` execs `dist/main.js`, gitignored) |
| `package.json` / `package-lock.json` | Workspace metadata + pinned dependency lock (npm workspaces, root-level) |

### User Home Directory

| Path | Description |
|---|---|
| `~/.werkmeister/slots.json` | Active slot assignments for all features |
| `~/workspace/<feature>/` | Feature workspace containing repo worktrees |

---

## Workflows

### Starting a New Feature

```bash
# 1. Ensure k8s baseline is running
werkmeister k8s-connect
werkmeister k8s-status

# 2. Create your workspace directory (skip if your VK / agent runner already did)
mkdir -p ~/workspace/PROJ-1234
cd ~/workspace/PROJ-1234

# 3. Create worktrees for the repos you'll modify
git -C ~/repos/werkmeister worktree add ~/workspace/PROJ-1234/werkmeister feature/PROJ-1234

# 4. Make your code changes
cd ~/workspace/PROJ-1234/werkmeister
# ... edit files ...
git add . && git commit -m "WIP"

# 5. Start the feature
cd ~/workspace/werkmeister
werkmeister up PROJ-1234

# 6. Set the feature in your browser
# Visit https://frontend.local.sandbox.com/__werkmeister and enter "PROJ-1234"

# 7. Develop and iterate
werkmeister logs PROJ-1234
werkmeister restart PROJ-1234  # after code changes if hot-reload doesn't work

# 8. Tear down when done
werkmeister down PROJ-1234
```

### Adding a Service Mid-Development

If you started with just `frontend` but now need `backend` running locally:

```bash
# Check what's currently running
werkmeister services PROJ-1234

# Add backend to `services` in .werkmeister/workspace.yml, then
werkmeister init-workspace
werkmeister up PROJ-1234

# Verify
werkmeister services PROJ-1234
```

### Running Multiple Features Simultaneously

Each feature is fully isolated. Just `werkmeister up` each one:

```bash
werkmeister up PROJ-1234    # Gets slot 1
werkmeister up PROJ-5678    # Gets slot 2
werkmeister up PROJ-9012    # Gets slot 3

# Check all features
werkmeister status

# Switch between features in the browser via the feature selector UI
# Or use different browser profiles, each with a different X-Feature cookie
#
# Easiest: open a dedicated, isolated window per feature with the cookie
# already set and the window tagged [feature] in its title + a corner badge:
werkmeister open PROJ-1234
werkmeister open PROJ-5678 --path /categories/crm
```

### Running Playwright Tests

```bash
# Make sure the feature is running
werkmeister up PROJ-1234

# Run all Playwright tests
werkmeister test PROJ-1234

# Run a specific test file
werkmeister test PROJ-1234 -- tests/checkout.spec.ts

# Run in headed mode for debugging
werkmeister test PROJ-1234 -- --headed --debug
```

The test command sets `SANDBOX_FEATURE` and `SANDBOX_SLOT` in the Playwright process environment. Your Playwright config can use these to set the `X-Feature` header on all requests.

### Debugging a Service

```bash
# Tail logs for a specific service
werkmeister logs PROJ-1234 frontend

# Check service endpoints
werkmeister services PROJ-1234

# Access the service directly (bypassing Caddy)
curl http://localhost:11101/  # frontend at slot 1, offset 1

# Access via Caddy with feature header
curl -H "X-Feature: PROJ-1234" https://frontend.local.sandbox.com/

# Check container status
werkmeister status -v

# Restart after fixing
werkmeister restart PROJ-1234
```

---

## Troubleshooting

### "No available slots" Error

All 12 slots are occupied. Free one by stopping a feature:

```bash
werkmeister status          # See which features are active
werkmeister down old-feature  # Free up a slot
```

### k8s Port-Forwards Are Down

```bash
# Check container status
werkmeister k8s-status

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
cat ~/workspace/PROJ-1234/compose.yml

# Try starting manually for more verbose output
docker compose -f ~/workspace/PROJ-1234/compose.yml up

# Check container logs
docker compose -f ~/workspace/PROJ-1234/compose.yml logs

# Verify workspace exists
ls ~/workspace/PROJ-1234/
```

### Feature Not Routing Correctly

```bash
# Verify the Caddyfile includes your feature
cat ~/.werkmeister/infra/proxy/Caddyfile | grep -A 5 "PROJ-1234"

# Regenerate and reload
werkmeister proxy-reload

# Test with explicit header
curl -v -H "X-Feature: PROJ-1234" https://frontend.local.sandbox.com/

# Check Caddy is running
docker compose -f infra/compose/shared-infra.yml ps caddy
```

### Services Not Auto-Detected

```bash
# Check that the workspace has committed changes
cd ~/workspace/PROJ-1234/werkmeister
git diff main..HEAD --name-only

# Verify repo name matches config
grep -A 3 "repos:" infra/config/services.yaml

# Add the service manually: list it in `services` in .werkmeister/workspace.yml, then
werkmeister init-workspace
werkmeister up PROJ-1234
```

### Build/Dependency Errors

```bash
# Reinstall dependencies and rebuild the CLI
rm -rf node_modules apps/cli/dist
npm install
npm --prefix apps/cli run build
werkmeister --help

# Check the node version — must be 20+
node --version

# werkmeister picks a runtime: SANDBOX_NODE, then PATH, then the newest nvm
# install. Pin it explicitly if the wrong one is found:
SANDBOX_NODE=/opt/homebrew/bin/node werkmeister --help

# Update a dependency
#   1. Edit the version in apps/cli/package.json
#   2. npm install   # re-resolve and update package-lock.json
#   3. npm --prefix apps/cli run build
```

> `werkmeister hooks gate` deliberately bypasses the CLI import chain via
> `dist/lib/gate.js` for a fast PreToolUse cold start — if the gate misbehaves,
> confirm `dist/` is built before debugging further.

### Stale Slot Data

If `~/.werkmeister/slots.json` gets out of sync (e.g., containers were removed manually):

```bash
# View current slot data
cat ~/.werkmeister/slots.json | jq .

# Reset by running down on stale features
werkmeister down stale-feature

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
│  │  2. Serve feature selector UI (/__werkmeister)                     │    │
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
├── compose.yml      ← Generated from infra/templates/
├── .env                    ← Service URLs, DB connections
└── .werkmeister/
    └── supergraph-config.yml   ← GraphQL federation routing (optional)

Docker Network: sandbox-PROJ-1234 (isolated)

Containers:
├── sandbox-PROJ-1234-backend     (:11100 → :3000)
└── sandbox-PROJ-1234-frontend     (:11101 → :3000)
```

### Lifecycle Flow

```
werkmeister up PROJ-1234
    │
    ├── 1. Scan workspace (~/workspace/PROJ-1234/)
    │       └── git diff main..HEAD in each repo
    │
    ├── 2. Allocate slot → ~/.werkmeister/slots.json
    │
    ├── 3. Generate files → ~/workspace/PROJ-1234/
    │       ├── compose.yml      (from infra/templates/)
    │       ├── .env                    (from infra/templates/)
    │       └── .werkmeister/supergraph-config.yml  (if a GraphQL subgraph exists)
    │
    ├── 4. Verify k8s forwards → werkmeister k8s-status
    │
    ├── 5. Start containers → docker compose up -d
    │
    └── 6. Update proxy → ~/.werkmeister/infra/proxy/Caddyfile → caddy reload
```
