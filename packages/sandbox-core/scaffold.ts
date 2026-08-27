/**
 * Seed content for the machine-global config files in `~/.sandbox`.
 *
 * These files used to be committed under `<repo>/infra/config/`. They describe
 * the developer's machine — which services exist, which ports they get, what
 * models cost — not the checkout, so they now live in `~/.sandbox` and this
 * module is the only place their initial content is defined. `sandbox setup`
 * writes each one exactly once: seeding NEVER overwrites an existing file, so
 * a re-run can't clobber hand edits.
 *
 * Everything here is emitted as literal YAML text rather than built from
 * objects and serialised, because the comments ARE the documentation — a
 * `YAML.stringify` round-trip would strip them and leave the user staring at a
 * bare registry with no explanation of what any key does.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** One seeded file and what happened to it. */
export interface SeedResult {
  path: string;
  /** "created" — written now; "present" — already existed, left alone. */
  status: "created" | "present";
}

// ---------------------------------------------------------------------------
// ports.yaml
// ---------------------------------------------------------------------------

export const DEFAULT_PORTS_YAML = `# Port Allocation Scheme
# Each feature slot (1-12) gets a dedicated port range.
#
# k8s port-forward listen-ports (the 9000-range) are NOT defined here — they
# live per-service in services.yaml as \`k8s_forward_port:\` (single source of
# truth for the forward table).

feature_slots:
  count: 12
  base_port: 11100
  ports_per_slot: 20
  # Slot 1: 11100-11119
  # Slot 2: 11200-11219
  # ...
  # Slot 12: 12200-12219
`;

// ---------------------------------------------------------------------------
// model-pricing.yaml
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_PRICING_YAML = `# Per-million-token USD rates for estimating Claude Code usage cost.
# Add or reprice models here — no code change needed. Unknown models show
# token counts with no dollar estimate. Rates are approximate; update when
# published pricing changes.
models:
  claude-opus-4-8:  { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 }
  claude-sonnet-5:  { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.30 }
  claude-haiku-4-5: { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.10 }
`;

// ---------------------------------------------------------------------------
// secrets.env
// ---------------------------------------------------------------------------

/**
 * Render the starter secrets.env template.
 *
 * Empty by default: a service opts into a required secret by listing it in
 * its own `secrets:` entry in services.yaml, and `sandbox up` only fails fast
 * on the keys the feature's own services declare (lib/secrets.ts
 * `requiredSecretKeys`). Add real values here as your services need them.
 */
export function renderSecretsEnv(): string {
  return [
    "# Machine-global secrets — real values, never committed.",
    "#",
    "# Consumed by infra/templates/env.njk when generating each feature's .env,",
    "# and read directly by docker compose as an env_file. A service declares",
    "# the keys it needs via `secrets:` in its services.yaml entry; `sandbox up`",
    "# fails fast when a key a workspace's own services declare is missing or",
    "# empty. Add KEY=value lines below as your services require them.",
    "",
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// services.yaml
// ---------------------------------------------------------------------------

/** Header + archetype/MCP registries shared by both registry variants. */
function servicesPreamble(k8sContext: string): string {
  return `# Service Registry — maps services to repos, ports, and deployments.
# Used by the sandbox CLI to detect, generate, and route services.
#
# Seeded by \`sandbox setup\`; hand-edit freely. \`archetype:\` (optional) names an
# entry in the \`archetypes:\` registry below, bundling the standards routing,
# generated subagents, and MCP servers a service type contributes to workspace
# generation. Services with no archetype contribute only the universal
# \`comments\` base.

# Named service-type bundles. \`standards:\` keys must match a
# docs/standards/<key>.md module's \`domain:\` frontmatter; \`comments\` is
# universal/implicit and never listed. \`test:\` is the archetype's default test
# command, run from the service's repo root ({service} expands to the name).
archetypes:
  node-web:
    standards: [ui, config, testing]
    mcp_servers: [context7]
    test: "npm test"

# MCP server definitions the archetypes' \`mcp_servers:\` lists reference. The
# union across a workspace's archetypes is projected into .mcp.json by
# \`sandbox init-workspace\`. \`\${VAR:-}\` env expansion happens at session start,
# so secrets stay out of this file (context7 works keyless at lower limits).
mcp_servers:
  context7:
    type: stdio
    command: npx
    args: ["-y", "@upstash/context7-mcp"]
    env:
      CONTEXT7_API_KEY: "\${CONTEXT7_API_KEY:-}"

# Kube context for a dev cluster — consumed by \`sandbox intercept\`.
k8s_context: ${k8sContext}
`;
}

/**
 * The demo registry: the two apps in the `demo-services` repo, a small
 * turborepo checked out alongside `sandbox` under \`paths.repos_root\`. A
 * workspace that uses these services gets a `demo-services/` worktree next to
 * its `sandbox/` one.
 *
 * Note what is NOT here: \`feature_router.hostname\`. Public hostnames now derive
 * from \`ingress.local_domain\` / \`ingress.remote_domain\` in ~/.sandbox/config.yaml
 * (see feature_routing.ts), so frontend is reachable at
 * frontend.<local_domain> without restating the host per service. A service
 * that needs a non-conforming host still sets \`hostname:\` explicitly.
 */
function demoServices(): string {
  return `
services:
  backend:
    repo: demo-services
    path: apps/backend
    type: api
    test: "npm test"
    internal_port: 3000
    port_offset: 0
    health_endpoint: /health
    monorepo: null
    setup_service: demo-install
    # The repo root is mounted at /app; cd into the app's subdir (the template
    # runs \`command\` from /app and does not use \`path:\` for the working dir).
    image: node:22-alpine
    command: "cd apps/backend && exec node server.js"
    memory_limit: 256M
    memory_reservation: 64M
    node_modules_volume: node-modules
    # \`k8s-postgres\` is the k8s-forwards container's shared-network alias and
    # 9051 its *listen* port, not Postgres' 5432 — in-cluster the same database
    # is \`postgres:5432\` (charts/backend.values.yaml). Set here rather than in
    # .env because compose \`environment:\` wins over \`env_file:\` anyway, and the
    # credentials and key name are the app's knowledge, not the registry's.
    environment:
      DATABASE_URL: postgres://postgres:postgres@k8s-postgres:9051/postgres
    # Telepresence intercept coordinates (\`sandbox intercept\`). The demo apps also
    # run in the OrbStack cluster as same-named Deployments in \`default\`; intercept
    # reroutes cluster traffic carrying \`x-feature: <feature>\` to the local
    # container. k8s_port is the Service port NUMBER; k8s_port_name is the named
    # Service port (charts/webapp names it \`http\`) — required by the CLI's
    # named-port precondition.
    k8s_deployment: backend
    k8s_namespace: default
    k8s_port: 80
    k8s_port_name: http
    # Also port-forwarded into the docker world (like redis/postgres): the
    # k8s-forwards container tunnels the in-cluster pod to the host so feature
    # containers can reach the deployed app at k8s-forwards:9052. remote port is
    # the pod's containerPort (internal_port 3000), not the Service port.
    k8s_forward_port: 9052
    k8s_pod_prefix: backend

  frontend:
    repo: demo-services
    path: apps/frontend
    type: web
    archetype: node-web
    test: "npm test"
    internal_port: 3000
    port_offset: 1
    health_endpoint: /
    monorepo: null
    setup_service: demo-install
    # demo-services is an npm-workspaces turborepo: the install runs at /app (the
    # repo root) and deps hoist to /app/node_modules, NOT apps/frontend's.
    # demo-install has already populated that tree before this container starts,
    # so there is no boot-time install or probe here. npm puts the ancestor .bin
    # on PATH, so \`npm run dev\` still resolves \`next\` from the subdir.
    image: node:22-alpine
    command: "cd apps/frontend && exec npm run dev"
    memory_limit: 1G
    memory_reservation: 256M
    node_modules_volume: node-modules
    # Redis via the same forwarder alias as backend's Postgres; 9050 is the
    # listen port, not 6379. Backs the SSR grocery-list cache.
    environment:
      REDIS_URL: redis://k8s-redis:9050
    # Telepresence intercept coordinates (see backend). Service port is 8080.
    k8s_deployment: frontend
    k8s_namespace: default
    k8s_port: 8080
    k8s_port_name: http
    # Also port-forwarded into the docker world (see backend): reachable at
    # k8s-forwards:9053. remote is the pod containerPort (3000), not port 8080.
    k8s_forward_port: 9053
    k8s_pod_prefix: frontend
    # Caddy feature routing (feature_routing.ts): Caddy terminates the derived
    # hostname directly and
    # reverse-proxies to the running frontend container (via its published
    # host port). When an X-Feature cookie is present, its value is copied into
    # an X-Feature header on the upstream call so the app can read the feature.
    feature_router:
      # Local host derives from ingress.local_domain; remote from
      # ingress.remote_domain. \`remote_upstream\` is what opts this service into
      # a remote route at all — where Caddy dials the cluster deployment.
      # NOT cluster DNS (*.svc.cluster.local): there is no Caddy in the
      # cluster. BOTH hostnames resolve to 127.0.0.1 (/etc/hosts) and are
      # served by the one docker Caddy, which sits on the shared network and
      # cannot resolve CoreDNS names. Go through the k8s-forwards tunnel
      # instead — its \`k8s-<service>\` network alias plus the
      # \`k8s_forward_port\` above.
      remote_upstream: k8s-frontend:9053
    # frontend fetches http://backend/ server-side; the feature network
    # aliases each service to its name, so this dependency also guarantees
    # backend is healthy before frontend renders.
    depends_on:
      - backend

# Infrastructure forwarded from the OrbStack k8s cluster into the docker world.
# The k8s-forwards container \`kubectl port-forward\`s each Service (by deployment
# whose name starts with \`k8s_pod_prefix\`, in \`k8s_namespace\`) to the host on
# \`k8s_forward_port\`. Feature containers reach them at host.docker.internal:<port>
# — the ports the generated feature .env already expects (redis 9050, postgres
# 9051). Apply the k8s side from the demo-services repo (\`./bin/bootstrap-k8s-env.sh\`,
# or \`kubectl apply -f charts/redis.yaml -f charts/postgres.yaml\` there).
# \`health_endpoint\` names the probe that proves a forward alive: an HTTP path
# for HTTP services, \`redis\` or \`postgres\` for these (a dead forward still
# accepts TCP, so a connect proves nothing), "" for TCP-only.
infrastructure:
  redis:
    k8s_forward_port: 9050
    internal_port: 6379
    k8s_namespace: default
    k8s_pod_prefix: redis
    health_endpoint: redis
  postgres:
    k8s_forward_port: 9051
    internal_port: 5432
    k8s_namespace: default
    k8s_pod_prefix: postgres
    health_endpoint: postgres

# One shared install container. Both apps bind-mount the *same* repo at /app, so
# per-service volumes would mean two concurrent \`npm install\`s against one
# package-lock.json; this runs once and both apps gate on it
# (\`service_completed_successfully\`). The volume is per-feature, which is the
# point: npm installs optional native binaries (swc, esbuild, rollup, sharp) for
# the current platform+libc only, so a tree shared with the macOS host had each
# side silently overwriting the other's. \`image\` must match the apps' — a
# glibc-built tree will not load under alpine.
setup_services:
  demo-install:
    repo: demo-services
    image: node:22-alpine
    command: "npm install"
    node_modules_volume: node-modules

# Repo-to-directory mapping for auto-detection. Both apps live in the
# demo-services turborepo, cloned alongside sandbox under \`paths.repos_root\`;
# paths are relative to that checkout.
repos:
  demo-services:
    services: [backend, frontend]
    path_mappings:
      apps/backend: backend
      apps/frontend: frontend
`;
}

/**
 * An empty registry with every section present and documented.
 *
 * `services:` must be a non-empty mapping before `sandbox up` can do anything,
 * so this variant is a starting point to fill in, not a working config — the
 * commented-out block shows the shape of one entry.
 */
function emptyServices(): string {
  return `
# Your services. Each entry maps a service name to where its source lives and
# how to run it. \`sandbox detect\` matches a repo checkout to these entries via
# the \`repos:\` mapping at the bottom of this file.
#
# services:
#   my-api:
#     repo: my-repo                 # key in \`repos:\` below
#     path: services/my-api         # path within the repo checkout
#     type: api                     # api | web
#     archetype: node-web           # optional; key in \`archetypes:\` above
#     internal_port: 3000           # port the process listens on in-container
#     port_offset: 0                # slot-relative host port (unique per service)
#     health_endpoint: /health      # or redis | postgres | "" (TCP-only)
#     image: node:22-alpine
#     command: "cd services/my-api && exec npm start"
#     memory_limit: 1G
#     memory_reservation: 256M
#     # Optional — opts the service into Caddy ingress. The public hostname
#     # derives from ingress.local_domain in ~/.sandbox/config.yaml as
#     # <service>.<local_domain>; set \`hostname:\` here only to override it.
#     feature_router: {}
#     # Optional — env keys this service needs from ~/.sandbox/secrets.env.
#     # \`sandbox up\` fails fast on any that are missing or empty, but only
#     # for services in the feature workspace being started.
#     secrets: [MY_API_TOKEN]
services: {}

# Non-service infra forwarded from the k8s cluster into the docker world by the
# k8s-forwards container. Feature containers reach each at
# host.docker.internal:<k8s_forward_port>.
#
# infrastructure:
#   redis:
#     k8s_forward_port: 9050
#     internal_port: 6379
#     k8s_namespace: default
#     k8s_pod_prefix: redis
#     health_endpoint: redis
infrastructure: {}

# Shared setup containers (e.g. a monorepo-wide \`npm install\`) that services
# depend on before starting.
setup_services: {}

# Repo-to-service mapping for auto-detection.
#
# repos:
#   my-repo:
#     services: [my-api]
#     path_mappings:
#       services/my-api: my-api
repos: {}
`;
}

export interface ServicesYamlOptions {
  /** Seed the sandbox repo's two demo apps rather than an empty skeleton. */
  demo?: boolean;
  /** Kube context for `sandbox intercept` (services.yaml `k8s_context`). */
  k8sContext?: string;
}

/** Render the initial services.yaml text. */
export function renderServicesYaml(options: ServicesYamlOptions = {}): string {
  const k8sContext = options.k8sContext?.trim() || "orbstack";
  return servicesPreamble(k8sContext) + (options.demo ? demoServices() : emptyServices());
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Write *content* to *target* only when it does not already exist.
 *
 * The never-overwrite rule is what makes `sandbox setup` safe to re-run: the
 * registry files accumulate hand edits, and a setup pass must converge the
 * machine without touching them.
 */
export function seedFile(target: string, content: string, mode = 0o644): SeedResult {
  if (fs.existsSync(target)) {
    return { path: target, status: "present" };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
  // writeFileSync's mode applies only to a file it creates; chmod separately so
  // a pre-existing-but-empty path still lands on the intended permissions.
  fs.chmodSync(target, mode);
  return { path: target, status: "created" };
}
