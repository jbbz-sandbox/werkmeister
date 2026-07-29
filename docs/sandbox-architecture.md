# Developer Sandbox Architecture

## Multi-Feature Concurrent Development for Distributed Application

---

## Overview

A system that enables up to 12 Claude Code agents to concurrently develop features across a distributed application (~20 services, ~9 repos) on a 32GB M2 Mac. Each feature runs only the services it modifies locally (typically ~3), with everything else port-forwarded from GKE. A reverse proxy routes traffic per-feature using HTTP headers/cookies.

---

## Core Design Principles

1. **Minimal local footprint** — only run containers for services with code changes; everything else comes from GKE via `kubectl port-forward`.
2. **Feature isolation** — each feature gets its own Docker network, port range, and routing identity. No cross-contamination.
3. **Auto-detection** — the system infers which services to run locally by analyzing which repos/worktrees have changes.
4. **Shared state** — single shared dev database and Redis (containerized, on the shared Docker network). No per-feature data isolation needed.
5. **Production-parity routing** — the Cloudflare Worker runs the consolidated `tr-proxy` app locally (in `IS_SANDBOX` mode) — the same real code deployed to dev/stage/prod, no fork. It does buyer-site path routing and forwards each web service to a Caddy internal router; Caddy resolves feature-vs-GKE per request from the `X-Feature` cookie.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser / Playwright                                               │
│  Cookie: X-Feature=my-feature                                       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTPS (:443)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Caddy  (sb-web.local.sandbox.com:443)                          │
│                                                                     │
│  • TLS termination (local certs)                                    │
│  • Serves feature selector UI at /__sandbox/                        │
│  • Sets X-Feature, X-Sandbox-Slot, X-Sandbox-Base-Port headers      │
│  • Forwards ALL other traffic to cloudflare-worker:8787             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker — tr-proxy (sandbox-cloudflare-worker:8787)      │
│                                                                     │
│  • Production routing rules (119+ path routes, 200+ redirects)      │
│  • Path-based service selection → forwards to caddy:91xx routers    │
│  • Security headers, redirects                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ (per web service)
┌──────────────────────────────▼──────────────────────────────────────┐
│  Caddy internal routers (caddy:9100/9101/9102/9103)                 │
│  • Match X-Feature cookie → local container, else GKE baseline      │
└──────────┬──────────────────────────────────┬───────────────────────┘
           │                                  │
     ┌─────▼──────┐                    ┌──────▼──────┐
     │  Local      │                    │  GKE        │
     │  Containers │                    │  Baseline   │
     │  (host.docker│                   │  (gke-fwds  │
     │   .internal)│                    │   container)│
     └─────────────┘                    └─────────────┘

All services communicate via Docker DNS on the sandbox-shared network.
Local feature containers are reached from Caddy via host.docker.internal:<port>.
GKE services are reached via the gke-forwards container (e.g., gke-forwards:9000).
```

---

## Component Details

### 1. Reverse Proxy (Caddy)

**Why Caddy**: native header/cookie matching, automatic config reload, simple config syntax, lightweight, built-in TLS support.

**Role in the new architecture**: Caddy is the browser-facing entry point. It terminates HTTPS, serves the feature selector UI, and forwards everything else to the Cloudflare Worker for path-based routing. Caddy no longer does path-based routing itself -- that responsibility belongs to the worker.

**What Caddy does**:
- Terminates HTTPS/TLS using local certificates (mounted from `~/.docker/certs`).
- Serves the feature selector UI at `/__sandbox/` -- a static page that lets the user pick a feature and sets the `X-Feature` cookie.
- Sets `X-Feature`, `X-Sandbox-Slot`, and `X-Sandbox-Base-Port` headers on proxied requests (read from the cookie or incoming header).
- Forwards ALL non-`/__sandbox` traffic to `cloudflare-worker:8787` (the Cloudflare Worker running on the Docker network).
- Routes `vendor.local.sandbox.com` to the worker with the `Host` header rewritten to `vendors.dev.sandbox.com`.
- No feature header/cookie means default (GKE baseline) routing through the worker.

**Caddyfile generation**: The orchestrator CLI regenerates the Caddyfile whenever a feature is started/stopped. Caddy watches for changes and hot-reloads.

```
# Example generated Caddyfile snippet
sb-web.local.sandbox.com {
    tls /etc/caddy/certs/localhost.crt /etc/caddy/certs/localhost.key

    # Feature selector UI
    handle_path /__sandbox/* {
        root * /sandbox/proxy/ui
        file_server
    }

    # Feature: payment-refactor (slot 1)
    @payment_refactor expression `header({'X-Feature': 'payment-refactor'}) || header_regexp('Cookie', '.*X-Feature=payment-refactor.*')`
    handle @payment_refactor {
        reverse_proxy cloudflare-worker:8787 {
            header_up X-Feature payment-refactor
            header_up X-Sandbox-Slot 1
            header_up X-Sandbox-Base-Port 11100
        }
    }

    # Default: forward to worker with no feature header (GKE baseline)
    reverse_proxy cloudflare-worker:8787
}
```

#### Caddy internal feature routers

Besides the browser-facing `:443` site, the same Caddy process hosts a set of
**internal HTTP listeners** — one per feature-routable web service — that the
worker forwards to (`SANDBOX_WEBV*_URL=http://caddy:91xx`). Each resolves
feature-vs-GKE from the `X-Feature` cookie:

```
# web-v2 router — tr-proxy dials caddy:9102
:9102 {
    @payment_refactor header_regexp Cookie X-Feature=payment-refactor(;|$)
    handle @payment_refactor {
        reverse_proxy host.docker.internal:11102   # feature's local container
    }
    reverse_proxy gke-forwards:9010                # GKE baseline fallback
}
```

A feature only gets a match block on a listener for a service it runs locally,
so per-service granularity is preserved (e.g. web-v2 local, web-v1 from GKE).
The listeners + per-feature match blocks are generated into the Caddyfile by
`generate.ts` (`_build_internal_routers`), keyed off the router table in
`apps/cli/src/lib/feature_routing.ts`, and refreshed on every `sandbox up`/`down` reload.

### 2. Cloudflare Worker Proxy

The Cloudflare Worker is the path-based routing brain of the sandbox. It runs the consolidated **`tr-proxy`** app locally via `wrangler dev`, in sandbox mode (`IS_SANDBOX=true`). `tr-proxy` is the same real worker deployed to dev/stage/prod — there is no sandbox fork — so buyer-site path routing (the shared `ProxyHandler`) matches production exactly. Feature-vs-GKE resolution is **not** done here; the worker forwards each web service to a Caddy internal router (see below).

**How it runs**:
- Docker container `sandbox-cloudflare-worker` using `node:20-slim`.
- The `cloudflare-workers` repo (specifically the `tr-proxy` app) is mounted as a volume.
- Runs `wrangler dev --port 8787 --ip 0.0.0.0` inside the container.
- Connected to the `sandbox-shared` Docker network with the DNS alias `cloudflare-worker`.
- Depends on `gke-forwards` being healthy before starting.

**What it does**:
- **Path-based routing** (119+ rules): maps URL paths to backend services. Examples:
  - `/categories/*` -> webV2
  - `/products/*/reviews` -> webV1
  - `/api/v2/*` -> sb-web-api
  - Catch-all -> webV0
- **Redirect rules** (200+): production redirect logic, SEO rewrites.
- **Security headers**: CSP, HSTS, X-Frame-Options, etc.

**Endpoint resolution** (in Caddy, not the worker):
- `tr-proxy` points each web service at a Caddy internal router instead of at a
  backend directly. These are plain-HTTP listeners on the shared Docker network,
  one per feature-routable service (see `apps/cli/src/lib/feature_routing.ts`):
  ```
  SANDBOX_WEBV0_URL=http://caddy:9100
  SANDBOX_WEBV1_URL=http://caddy:9101
  SANDBOX_WEBV2_URL=http://caddy:9102
  SANDBOX_MCP_URL=http://caddy:9103
  SANDBOX_LOGGING_URL=http://gke-forwards:9000   # not feature-routed
  ```
- Each router matches the `X-Feature` cookie (forwarded unchanged through the
  worker) and routes to the feature's local container if that feature runs the
  service locally, else to the GKE baseline (`gke-forwards:<port>`).
- Because resolution lives in Caddy, `infra/proxy/worker.env` is now **static**
  (the same for every feature set), and starting/stopping a feature only reloads
  Caddy — the shared worker no longer needs restarting.

The per-feature routing table therefore lives in the generated Caddyfile (see
§Caddy internal feature routers), not in `worker.env`.

### 3. Port Allocation Scheme

Each feature slot (1–12) gets a port range. Deterministic, no collisions.

| Slot | Feature Port Range | Usage |
|------|-------------------|-------|
| 1    | 11100–11119       | Up to 20 service ports |
| 2    | 11200–11219       | |
| 3    | 11300–11319       | |
| ...  | ...               | |
| 12   | 12200–12219       | |

**GKE port-forwards** run inside the `gke-forwards` container and are accessible via Docker DNS (e.g., `gke-forwards:9000`). Host ports are also exposed for debugging:

| Listen Port | GKE Service | Docker DNS Alias |
|-------------|-------------|------------------|
| 9000 | web-v0 (baseline) | `gke-web-v0` |
| 9001 | sb-web-api | `gke-sb-web-api` |
| 9002 | category-api | `gke-category-api` |
| 9003 | product-api | `gke-product-api` |
| 9004 | federated-graph | `gke-federated-graph` |
| 9005 | taxonomy-api | `gke-taxonomy-api` |
| 9006 | interview-api | `gke-interview-api` |
| 9007 | vendor-portal-server | `gke-vendor-portal-server` |
| 9008 | sandbox-mcp | `gke-sandbox-mcp` |
| 9052 | mongodb | `gke-mongodb` |

**Shared infrastructure** (not GKE -- runs locally as containers):

| Service | Docker DNS | Port |
|---------|-----------|------|
| Redis | `redis` | 6379 |
| Cloud SQL Proxy | `cloud-sql-proxy` | 5432 |

These are defined in `infra/compose/shared-infra.yml` and managed by Docker Compose.

### 4. Service Registry & Auto-Detection

A central config maps repos → services → Docker compose files:

```yaml
# sandbox-config/services.yaml
services:
  web-app:
    repo: turbo-mono
    path: apps/web-app
    compose: infra/compose/web-app.yml
    type: web
    port_offset: 0          # within feature's port range
    gke_deployment: web-app
    gke_namespace: dev
    gke_port: 3000

  rest-orders:
    repo: turbo-mono
    path: apps/rest-orders
    compose: infra/compose/rest-orders.yml
    type: rest
    port_offset: 1
    gke_deployment: rest-orders
    gke_namespace: dev
    gke_port: 4000

  graphql-inventory:
    repo: standalone-inventory
    path: .
    compose: infra/compose/graphql-inventory.yml
    type: graphql-subgraph
    port_offset: 2
    gke_deployment: graphql-inventory
    gke_namespace: dev
    gke_port: 4001

  # ... all ~20 services
```

**Auto-detection algorithm**:

```
For a given feature workspace:
  1. List all worktree directories in the workspace
  2. For each worktree, identify the repo name
  3. Run `git diff main..HEAD --name-only` in each worktree
  4. Map changed file paths → services using services.yaml path mappings
  5. Result: set of services that need to run locally
  6. Everything else: use GKE port-forward
```

**Re-detection triggers**:
- On `sandbox up` (initial)
- On Vibe Kanban status change (e.g., moving to "in review")
- On-demand via `sandbox detect <feature>`
- Optionally: file watcher that re-detects when new files are committed

### 5. Orchestrator CLI (`sandbox`)

The core tool that agents and developers invoke.

```bash
# Lifecycle
sandbox up <feature>         # detect services, start containers, configure proxy
sandbox down <feature>        # stop containers, remove proxy routes
sandbox restart <feature>     # restart feature's containers
sandbox status               # show all features, their services, resource usage

# Inspection
sandbox detect <feature>     # analyze worktrees, show which services would run locally
sandbox services <feature>   # list services and their endpoints for this feature
sandbox logs <feature> [svc] # tail logs for a feature's service

# Manual overrides
sandbox up <feature> -s <svc>  # force a service to run locally
sandbox remove <feature> <svc> # stop a local service, fall back to GKE

# Testing
sandbox test <feature>       # run Playwright against this feature's stack

# Infrastructure
sandbox infra-up             # start shared infrastructure (redis, cloud-sql, gke-forwards, worker, caddy)
sandbox gke-status           # check gke-forwards container health
sandbox proxy-reload         # regenerate Caddyfile + worker.env, restart worker
```

**Implementation**: A TypeScript CLI that lives in the sandbox repo. Each command is a module in `apps/cli/src/commands/`.

### 6. Per-Feature Docker Compose Generation

When `sandbox up <feature>` runs, it dynamically generates a `docker-compose.feature-<name>.yml`:

```yaml
# Auto-generated for feature: payment-refactor
# Services detected: web-v2, rest-orders

networks:
  feature-payment-refactor:
    name: sandbox-payment-refactor
  sandbox-shared:
    external: true

services:
  web-v2:
    build:
      context: /Users/dev/workspaces/payment-refactor/turbo-mono
      dockerfile: apps/web-v2/Dockerfile
      target: development     # use dev stage for hot-reload
    ports:
      - "11100:3060"
    environment:
      - REST_ORDERS_URL=http://rest-orders:4000          # local (same feature)
      - REST_USERS_URL=http://gke-forwards:9003          # GKE baseline
      - GRAPHQL_GATEWAY_URL=http://gke-forwards:9004     # GKE baseline
      - REDIS_URL=redis://redis:6379                     # shared infra
      - DATABASE_URL=postgresql://cloud-sql-proxy:5432/dev  # shared infra
    volumes:
      - /Users/dev/workspaces/payment-refactor/turbo-mono/apps/web-v2/src:/app/src
    networks:
      feature-payment-refactor:
        aliases:
          - web-v2
      sandbox-shared:
        aliases:
          - web-v2

  rest-orders:
    build:
      context: /Users/dev/workspaces/payment-refactor/turbo-mono
      dockerfile: apps/rest-orders/Dockerfile
      target: development
    ports:
      - "11101:4000"
    environment:
      - GRAPHQL_GATEWAY_URL=http://gke-forwards:9004     # GKE baseline
      - REDIS_URL=redis://redis:6379                     # shared infra
      - DATABASE_URL=postgresql://cloud-sql-proxy:5432/dev  # shared infra
    volumes:
      - /Users/dev/workspaces/payment-refactor/turbo-mono/apps/rest-orders/src:/app/src
    networks:
      feature-payment-refactor:
        aliases:
          - rest-orders
      sandbox-shared:
        aliases:
          - rest-orders
```

**Key design choices**:
- Docker DNS aliases on the `sandbox-shared` network to reach all services -- no `host.docker.internal` anywhere.
- Local services (same feature): referenced by Docker DNS name (e.g., `http://rest-orders:4000`).
- GKE baseline services: reached via the `gke-forwards` container (e.g., `http://gke-forwards:9004`).
- Shared infrastructure: Redis at `redis://redis:6379`, Postgres at `postgresql://cloud-sql-proxy:5432/dev`.
- Feature containers join both the per-feature network (isolation) and the `sandbox-shared` network (access to shared infra and GKE forwards).
- Volume mounts for hot-reload of source code from the worktree.
- Environment variables are generated per-service, mixing local and GKE endpoints using Docker DNS names.

### 7. Apollo Federation Gateway Configuration

The gateway needs to know where each subgraph lives. Since subgraph locations vary per feature (some local, some GKE), the config must be per-feature.

**Approach**: Generate a `supergraph-config.yaml` per feature and mount it into the gateway container (or the GKE gateway if the gateway itself isn't running locally). All URLs use Docker DNS names on the `sandbox-shared` network.

```yaml
# Auto-generated: supergraph-config.payment-refactor.yaml
subgraphs:
  inventory:
    routing_url: http://gke-forwards:9005            # GKE baseline
    schema:
      subgraph_url: http://gke-forwards:9005
  orders:
    routing_url: http://rest-orders:4000             # LOCAL (Docker DNS)
    schema:
      subgraph_url: http://rest-orders:4000
  users:
    routing_url: http://gke-forwards:9006            # GKE baseline
    schema:
      subgraph_url: http://gke-forwards:9006
```

If the gateway itself runs on GKE (not locally), the feature's local services would need to be exposed via a tunnel (e.g., `cloudflared` or `ngrok`) so GKE can reach them. **Recommendation**: always run the gateway locally per-feature if any subgraph is local -- it's lightweight and avoids tunneling complexity.

### 8. GKE Port-Forward Manager (Containerized)

All GKE port-forwards run inside a single Docker container (`gke-forwards`) rather than as host-level background processes. This simplifies lifecycle management, networking, and health monitoring.

**Container details**:
- Built from `infra/compose/gke-port-forward/Dockerfile` (based on `google/cloud-sdk:slim`).
- Installs `gke-gcloud-auth-plugin`, `curl`, and `netcat` for auth and health checks.
- Entrypoint script (`infra/compose/gke-port-forward/entrypoint.sh`) runs all port-forwards as background processes with auto-restart loops.
- Mounts `~/.kube` and `~/.config/gcloud` (read-only) for `kubectl` authentication.

**Networking**:
- Connected to the `sandbox-shared` Docker network.
- Registers DNS aliases for each forwarded service (e.g., `gke-web-v0`, `gke-sb-web-api`, `gke-category-api`, `gke-mongodb`).
- The primary alias `gke-forwards` is the canonical name used by other containers.
- Each forward listens on `0.0.0.0:<listen_port>` so it is reachable from any container on the shared network.

**Port mappings** (inside the `gke-forwards` container):

| Listen Port | GKE Service | Namespace | Remote Port |
|-------------|-------------|-----------|-------------|
| 9000 | web-v0 | sandbox | 3000 |
| 9001 | sb-web-api | sandbox | 3061 |
| 9002 | category-api | category | 3001 |
| 9003 | product-api | product | 3001 |
| 9004 | federated-graph | federated-graph | 4321 |
| 9005 | taxonomy-api | taxonomy-service | 3001 |
| 9006 | interview-api | interview-service | 3004 |
| 9007 | vendor-portal-server | vendor-portal | 3003 |
| 9008 | sandbox-mcp | sandbox-mcp | 4322 |
| 9052 | mongodb | psmdb | 27017 |

**Health checks**: Docker Compose healthcheck probes key ports (`nc -z localhost 9000 && nc -z localhost 9002 && nc -z localhost 9052`). The container reports healthy only when the critical forwards are established. Other containers (e.g., `cloudflare-worker`) use `depends_on: gke-forwards: condition: service_healthy` to wait.

**Lifecycle**: Managed entirely by Docker Compose. Auto-restarts on failure (`restart: unless-stopped`). Logs are accessible via `docker logs sandbox-gke-forwards`. The `sandbox gke-status` command checks the container's health status.

### 9. Playwright Integration

Each feature can run its full Playwright test suite against its own isolated stack.

**Setup**:
```javascript
// playwright.config.ts — generated or parameterized per feature
export default defineConfig({
  use: {
    baseURL: 'https://sb-web.local.sandbox.com',
    extraHTTPHeaders: {
      'X-Feature': process.env.SANDBOX_FEATURE || 'default',
    },
  },
});
```

**Execution**:
```bash
sandbox test payment-refactor
# Equivalent to:
# SANDBOX_FEATURE=payment-refactor npx playwright test
```

The `X-Feature` header propagates through Caddy to the Cloudflare Worker, which routes to the correct containers. Playwright hits the same `sb-web.local.sandbox.com` URL every feature uses -- only the header differs.

**Header propagation for API calls from the browser**: The web app needs to forward the `X-Feature` cookie/header on its API calls. Options:
- The reverse proxy injects the header on all proxied requests based on the cookie (simplest — Caddy handles this).
- The web app reads the cookie and includes it in fetch headers (requires a small code change, but more explicit).

**Recommendation**: Have Caddy inject the header. Zero code changes to the application.

---

## Directory Structure

```
~/sandbox/                              # Developer sandbox repo
├── sandbox                             # CLI entrypoint (bash wrapper -> node)
├── apps/cli/src/               # CLI command scripts
│   ├── up.sh
│   ├── down.sh
│   ├── detect.sh
│   ├── status.sh
│   ├── test.sh
│   └── proxy-reload.sh
├── infra/config/
│   ├── services.yaml                   # Service registry
│   └── ports.yaml                      # Port allocation map
├── infra/compose/                      # Docker Compose files
│   ├── shared-infra.yml                # Shared infrastructure (redis, cloud-sql-proxy,
│   │                                   #   gke-forwards, sb-sandbox-proxy worker, caddy)
│   ├── gke-port-forward/               # Containerized GKE port-forwards
│   │   ├── Dockerfile                  # Based on google/cloud-sdk:slim
│   │   └── entrypoint.sh              # Port-forward supervisor script
│   ├── web-v0.yml                      # Per-service compose files
│   ├── web-v1.yml
│   ├── web-v2.yml
│   ├── sb-web-api.yml
│   ├── category-api.yml
│   ├── product-api.yml
│   ├── federated-graph.yml
│   ├── taxonomy-api.yml
│   ├── interview-api.yml
│   ├── vendor-portal-server.yml
│   ├── vendor-portal-client.yml
│   └── sandbox-mcp.yml
├── infra/templates/
│   ├── docker-compose.feature.yml.j2   # nunjucks template for per-feature compose
│   ├── Caddyfile.j2                    # Template for proxy config
│   └── supergraph-config.yml.j2        # Template for Apollo gateway
├── infra/proxy/
│   ├── Caddyfile                       # Generated — do not edit
│   ├── worker.env                      # Generated worker endpoint overrides (gitignored)
│   └── ui/                             # Feature selector web UI
│       ├── index.html
│       └── features.json               # Generated feature list for UI
└── docs/
    ├── users-guide.md
    └── known-issues.md

~/workspaces/                           # Vibe Kanban workspaces
├── payment-refactor/
│   ├── docker-compose.yml              # Generated per-feature compose stack
│   ├── .env                            # Generated resolved env vars
│   ├── .sandbox/
│   │   └── supergraph-config.yml       # Generated Apollo gateway config
│   ├── turbo-mono/                     # git worktree
│   ├── nx-mono/                        # git worktree
│   └── standalone-inventory/           # git worktree
├── auth-redesign/
│   ├── docker-compose.yml
│   ├── .env
│   ├── .sandbox/
│   │   └── supergraph-config.yml
│   ├── turbo-mono/
│   └── standalone-auth/
└── ...
```

---

## Lifecycle: `sandbox up payment-refactor`

```
1. DETECT
   ├── Scan ~/workspaces/payment-refactor/ for worktrees
   ├── For each worktree: git diff main..HEAD --name-only
   ├── Map changed paths → services via services.yaml
   └── Result: [web-app, rest-orders]

2. ALLOCATE
   ├── Find next available feature slot (e.g., slot 3)
   ├── Assign port range 11300–11319
   └── Write slot assignment to ~/.sandbox/slots.json

3. GENERATE
   ├── Render docker-compose from template with:
   │   ├── Local services: web-app → 11300, rest-orders → 11301
   │   ├── GKE services: all others → their 9xxx ports
   │   └── Volume mounts pointing at worktree paths
   ├── Render supergraph-config.yml (if any graphql subgraph is local)
   └── Render .env file with all service URLs

4. VERIFY GKE
   ├── Check that gke-forwards container is healthy (docker inspect --format)
   └── If unhealthy/stopped: restart via docker compose -f infra/compose/shared-infra.yml up -d gke-forwards

5. START CONTAINERS
   ├── docker compose -f ~/workspaces/payment-refactor/docker-compose.yml up -d
   └── Wait for health checks

6. CONFIGURE PROXY
   ├── Regenerate Caddyfile with new feature routes
   ├── Regenerate infra/proxy/worker.env with per-feature endpoint overrides
   ├── Restart cloudflare-worker container to pick up new env vars
   └── Caddy hot-reloads Caddyfile changes automatically

7. REPORT
   └── Print feature URL, service endpoints, and status
       "✓ payment-refactor ready at https://sb-web.local.sandbox.com (cookie: X-Feature=payment-refactor)"
       "  Local:  web-app (:11300), rest-orders (:11301)"
       "  GKE:    graphql-gateway (:9004), redis (:9050), ..."
```

---

## Resource Estimation

**Per feature (3 local services, typical)**:
- ~512MB–1GB RAM (Node.js services with hot-reload)
- Minimal CPU when idle

**Shared overhead**:
- Caddy proxy: ~20MB
- Cloudflare Worker (wrangler dev): ~128–512MB
- GKE port-forwards container: ~64–256MB
- Redis: ~32–64MB
- Cloud SQL Proxy: ~32–64MB
- Docker daemon overhead: ~500MB

**Worst case (12 features × 3 services each = 36 containers)**:
- ~12–15GB RAM for containers
- ~1GB shared overhead
- Total: ~13–16GB — fits within 32GB with room for Claude Code agents and OS

**Typical case (8 features × 3 services, 2 features × 5 services)**:
- ~10–12GB RAM
- Comfortable headroom

---

## Vibe Kanban Integration

### Workspace Hooks

In each Vibe Kanban workspace, add a hook in the sandbox repo worktree:

```bash
# .vibe/hooks/on-status-change.sh
#!/bin/bash
FEATURE="$VIBE_FEATURE_NAME"
STATUS="$VIBE_NEW_STATUS"

case "$STATUS" in
  "in-progress")
    sandbox up "$FEATURE"
    ;;
  "in-review")
    sandbox test "$FEATURE"
    ;;
  "done"|"cancelled")
    sandbox down "$FEATURE"
    ;;
esac
```

### Claude Code Agent Integration

Each Claude Code agent operates in its own workspace and can invoke sandbox commands:

```bash
# Agent starting work on a feature
sandbox up payment-refactor

# Agent wants to check its work
sandbox test payment-refactor

# Agent adds a service it now needs
sandbox up payment-refactor -s graphql-orders

# Agent checks what's running
sandbox status
```

---

## Open Decisions

1. ~~**CLI language**~~ — **settled**: TypeScript on Node ≥20, with nunjucks for template rendering and the `yaml` package for generation. Commander owns argument parsing.

2. **Hot-reload strategy**: Volume-mount source into dev-stage containers (recommended for speed) vs. rebuild on change (simpler Dockerfiles)?

3. **Database migrations**: With 12 agents sharing one database, how do you handle schema changes? Options:
   - Schema changes only allowed on one feature at a time (serialized via a lock)
   - Each feature uses a prefixed schema (`payment_refactor_*`) — high code impact
   - Feature flags in migrations — most flexible but complex
   - **Recommended**: treat migration conflicts like merge conflicts — handle at review time

4. **Proxy header propagation**: Should web apps explicitly forward `X-Feature`, or should Caddy inject it on all proxied traffic? Caddy injection is simpler but the header wouldn't survive if a service makes an outbound call that doesn't go through the proxy.

5. **Playwright parallelism**: Can all 12 features run Playwright tests simultaneously, or is that too resource-heavy? May need a queue.
