/**
 * Seed content for the machine-global config files in `~/.werkmeister`.
 *
 * These files used to be committed under `<repo>/infra/config/`. They describe
 * the developer's machine — which services exist, which ports they get, what
 * models cost — not the checkout, so they now live in `~/.werkmeister` and this
 * module is the only place their initial content is defined. `werkmeister setup`
 * writes each one exactly once: seeding NEVER overwrites an existing file, so
 * a re-run can't clobber hand edits.
 *
 * The seeded files are literal YAML text because their comments ARE the
 * documentation. services.yaml is the exception: it is GENERATED from each
 * repo's .werkmeister/services.yaml fragment by registry_sync.ts, and only its
 * defaults (REGISTRY_DEFAULTS, below) live here, as data.
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
 * its own `secrets:` entry in services.yaml, and `werkmeister up` only fails fast
 * on the keys the feature's own services declare (secrets.ts
 * `resolveSecrets`). Add real values here as your services need them.
 */
export function renderSecretsEnv(): string {
  return (
    [
      "# Machine-global secrets — real values, never committed.",
      "#",
      "# A service declares the keys it needs via `secrets:` in its services.yaml",
      "# entry; `werkmeister up` writes them, as plain KEY, into that service's own",
      "# <workspace>/.env.<service>, and fails fast when one is missing or empty.",
      "#",
      "# Namespace a key by service as <SERVICE>__KEY (service name uppercased,",
      "# - -> _), e.g. MOBILE__EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=... It wins over a",
      "# plain KEY=... line, which stays a shared fallback. Namespaced keys a",
      "# service doesn't declare (e.g. test logins for agents) reach no container.",
      "",
    ].join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// services.local.yaml
// ---------------------------------------------------------------------------

/**
 * The per-machine registry overlay. `werkmeister registry sync` merges it LAST over
 * the generated ~/.werkmeister/services.yaml, so this is where hand edits live now;
 * the generated file itself is never edited.
 */
export function renderServicesLocalYaml(k8sContext: string): string {
  return `# Machine-local registry overrides — hand-edit freely.
#
# \`werkmeister registry sync\` (and \`werkmeister setup\`) regenerate ~/.werkmeister/services.yaml
# from every <repo>/.werkmeister/services.yaml under paths.repos_root, then merge
# this file over the result: maps merge, scalars and lists replace. A key here
# beats every fragment, e.g.
#
#   services:
#     frontend:
#       memory_limit: 2G
#
# Leave a repo's fragment out of the registry on this machine (its services,
# setup_services and infrastructure); delete the name to re-enable:
#
#   disabled_fragments: [demo-services]
#
# Kube context for a dev cluster — consumed by \`werkmeister intercept\`.
k8s_context: ${k8sContext.trim() || "orbstack"}
`;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Write *content* to *target* only when it does not already exist.
 *
 * The never-overwrite rule is what makes `werkmeister setup` safe to re-run: the
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

// ---------------------------------------------------------------------------
// Registry defaults (werkmeister-owned; merged under every repo's fragment)
// ---------------------------------------------------------------------------

/**
 * The `archetypes:` and `mcp_servers:` registries. Owned by werkmeister, not
 * by any app repo: `standards:` keys must match a docs/standards/<key>.md
 * module and the MCP bodies are projected verbatim into .mcp.json, so a
 * fragment references these by name and never redefines them.
 *
 * `${VAR:-}` strings are expanded by the MCP client at session start, not by
 * the registry merge — they are deliberately plain strings here.
 */
// Named so the CLI-argv guard in core_cli_spawns.test.ts (which greps core for
// a quoted werkmeister name closing an array) does not read this MCP-server
// reference as a CLI spawn.
const WERKMEISTER_MCP_SERVER = "werkmeister";

export const REGISTRY_DEFAULTS: Record<string, any> = {
  archetypes: {
    "node-web": {
      standards: ["ui", "config", "testing"],
      mcp_servers: ["context7"],
      test: "npm test",
    },
    "node-service": { standards: ["service", "testing"], test: "npm test" },
    "node-tool": {
      standards: ["engineering", "testing"],
      validate: "Library: run the unit/smoke tests. No URL, cookie, or Caddy step applies.",
    },
    "mcp-client": {
      standards: ["engineering", "testing"],
      mcp_servers: [WERKMEISTER_MCP_SERVER],
      validate:
        "Build, then npm run test:integration (Extension Development Host via @vscode/test-cli). " +
        "Walk the open items in MANUAL-CHECKLIST.md for anything visual.",
    },
  },
  // SW-69: unlike archetypes, a fragment may add caches; it may not redefine these.
  // Volumes, not host dirs: over the VM's file share a warm pnpm install took
  // 15.5 s against 5.6 s from a volume (SW-31).
  caches: {
    // No prune rule: node_modules is a per-feature volume, so pnpm copies from
    // the store and every store file has one link; `pnpm store prune` would empty it.
    "pnpm-store": {
      path: "/pnpm-store",
      env: { npm_config_store_dir: "/pnpm-store" },
      detect: ["pnpm-lock.yaml"],
    },
    // SW-35: without TURBO_CACHE_DIR a worktree's builds land in its main
    // checkout's .turbo, unbounded; turbo itself evicts past the max age on each run.
    turbo: {
      path: "/turbo-cache",
      env: { TURBO_CACHE_DIR: "/turbo-cache", TURBO_CACHE_MAX_AGE: "14d" },
      detect: ["turbo.json"],
      max_age: "14d",
    },
  },
  mcp_servers: {
    context7: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY:-}" },
    },
    [WERKMEISTER_MCP_SERVER]: {
      type: "http",
      url: "http://host.docker.internal:3002/mcp",
      headers: {
        Authorization: "Bearer ${WERKMEISTER_MCP_TOKEN}",
        "X-Werkmeister-Feature": "${FEATURE}",
      },
    },
  },
};
