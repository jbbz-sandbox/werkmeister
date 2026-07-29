/**
 * Configuration loading for the developer sandbox.
 *
 * Loads and parses the machine-global registry files in `~/.sandbox`:
 * - services.yaml   — service registry mapping repos to services
 * - ports.yaml      — port allocation map (k8s and local)
 *
 * Both used to be committed under `<repo>/infra/config/`. They describe the
 * developer's machine rather than the checkout, so they now live beside
 * config.yaml and are seeded by `sandbox setup` (see lib/scaffold.ts).
 * `getInfraRoot()` still points into the repo for the things that ARE code:
 * compose files, templates, the proxy UI, schemas and skills.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as YAML from "yaml";

import { Colors } from "./colors.js";
import { loadPaths, portsYamlPath, servicesYamlPath } from "./global_config.js";

export { Colors };

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------

function color(text: string, c: string): string {
  return `${c}${text}${Colors.RESET}`;
}

export function info(msg: string): void {
  console.log(color(`[info] ${msg}`, Colors.CYAN));
}

export function success(msg: string): void {
  console.log(color(`[ok]   ${msg}`, Colors.GREEN));
}

export function warn(msg: string): void {
  console.log(color(`[warn] ${msg}`, Colors.YELLOW));
}

export function error(msg: string): void {
  console.log(color(`[err]  ${msg}`, Colors.RED));
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory (Python `Path.expanduser`). */
export function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Return the root of the sandbox repo.
 *
 * `SANDBOX_ROOT` env var when set, else self-derived from this file's
 * compiled location (`<root>/dist/lib/config.js` -> two levels up).
 */
export function getSandboxRoot(): string {
  const override = process.env.SANDBOX_ROOT;
  if (override) return path.resolve(expandUser(override));
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Return the root of the MONOREPO containing the CLI.
 *
 * `getSandboxRoot()` is the CLI package (`<repo>/apps/cli`) — right for
 * `infra/`, wrong for the sibling apps under `<repo>/apps/`. Walks up looking
 * for the `apps/` directory rather than assuming a fixed depth, so a checkout
 * laid out differently (or an `SANDBOX_ROOT` already pointing at the repo root)
 * still resolves.
 */
export function getMonorepoRoot(): string {
  let dir = getSandboxRoot();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "apps"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return getSandboxRoot();
}

/**
 * Directory holding the canonical source-repo checkouts (and the
 * hand-authored top-level CLAUDE.md context file).
 *
 * Reads `paths.repos_root` from the global config (`~/.sandbox/config.yaml`
 * — the single source of truth), falling back to `~/workspace`. The
 * `SANDBOX_REPOS_ROOT` env var is a derived export for external processes and
 * is not read at runtime.
 */
export function getReposRoot(): string {
  const value = loadPaths()["repos_root"];
  if (value) {
    return path.resolve(expandUser(value));
  }
  return path.resolve(path.join(os.homedir(), "workspace"));
}

/**
 * Return the infra/ dir holding compose, templates, proxy, schemas and skills.
 *
 * These are grouped under <repo>/infra/ (see the monorepo layout) and are all
 * CODE — versioned with the checkout. The machine-specific registry files that
 * used to sit in `infra/config/` now live in `~/.sandbox` instead; reach them
 * via `servicesYamlPath()` / `portsYamlPath()`, not this helper.
 */
export function getInfraRoot(): string {
  return path.join(getSandboxRoot(), "infra");
}

/**
 * Walk up from cwd to find the nearest git repo root, return its parent.
 *
 * The parent of the git repo root is the workspace — the directory that
 * contains one or more worktrees checked out for a feature.
 *
 * Also handles the case where cwd itself is the workspace (i.e. the user
 * is sitting in the workspace directory rather than inside a worktree).
 *
 * Exported because worker.ts imports it.
 */
export function detectWorkspaceFromCwd(): string | null {
  const cwd = process.cwd();

  // First check: cwd itself is a workspace if any immediate subdirectory
  // contains a .git entry (worktrees or repos live directly inside).
  try {
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(cwd, entry.name, ".git"))) {
        return cwd;
      }
    }
  } catch {
    // PermissionError equivalent — fall through to the upward walk.
  }

  // Second check: walk upward to find a .git boundary, return its parent.
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return path.dirname(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the workspace directory for a feature.
 *
 * A workspace is the parent directory containing git worktrees for a feature:
 *
 *     $SANDBOX_WORKSPACES_ROOT/feature-a/     <- workspace (multi-repo)
 *         econx/                              <- worktree (.git file)
 *         comx/                               <- worktree (.git file)
 *
 *     ~/workspace/                            <- workspace (single-repo)
 *         econx/                              <- repo (.git dir)
 *
 * Resolution order:
 *
 * 1. `--workspace` flag (explicit path)
 * 2. `paths.workspaces_root` from the global config (`~/.sandbox/config.yaml`)
 * 3. Auto-detect from cwd (traverse up to nearest `.git`, return parent)
 * 4. Fallback: `~/workspace`
 */
export function resolveWorkspace(feature: string, workspaceOverride?: string | null): string {
  if (workspaceOverride) {
    return path.resolve(workspaceOverride);
  }

  const configured = loadPaths()["workspaces_root"];
  if (configured) {
    const root = path.resolve(expandUser(configured));
    const cwd = path.resolve(process.cwd());
    // Multi-feature layout: CWD sits inside <root>/<feature>/... .
    // Return the first segment of CWD relative to root — the feature dir.
    // Mirrors init-workspace's workspace-root resolution so every command
    // agrees on what "the workspace" is.
    const rel = path.relative(root, cwd);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return path.join(root, rel.split(path.sep)[0]);
    }
    // CWD is the env root itself (or unrelated). If <root>/<feature>/
    // exists, prefer that (multi-feature). Otherwise return the root
    // as-is (single-repo layout: <root>/<repo>/, no per-feature subdir).
    const featureDir = path.join(root, feature);
    if (fs.existsSync(featureDir) && fs.statSync(featureDir).isDirectory()) {
      return featureDir;
    }
    return root;
  }

  const detected = detectWorkspaceFromCwd();
  if (detected) {
    return detected;
  }

  return path.join(os.homedir(), "workspace");
}

// ---------------------------------------------------------------------------
// YAML loaders
// ---------------------------------------------------------------------------

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Load a YAML file and return its contents as a dict.
 *
 * Optional configs (`required=false`, the default) preserve today's
 * tolerant behavior: a missing file (or one that parses to something other
 * than a mapping) warns and returns `{}` so callers can proceed with an
 * empty config.
 *
 * Required configs (`required=true`) fail loud instead: a missing file,
 * or one that parses to empty/non-dict content, throws an Error with a
 * message naming the path and stating it is required. This is the
 * deliberate silent-to-loud conversion for DEBT-01/D-02 — required configs
 * must never let generation proceed on empty config.
 */
function loadYaml(filePath: string, { required = false } = {}): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    if (required) {
      const msg =
        `Required config file not found: ${filePath}\n` +
        "Run `sandbox setup` to seed the machine-global config in ~/.sandbox.";
      error(msg);
      throw new Error(msg);
    }
    warn(`Config file not found: ${filePath}`);
    return {};
  }
  const data = YAML.parse(fs.readFileSync(filePath, "utf8"));
  if (!isDict(data) || Object.keys(data).length === 0) {
    if (required) {
      const msg =
        `Required config file is empty or invalid: ${filePath}\n` +
        "Run `sandbox setup` to seed the machine-global config in ~/.sandbox.";
      error(msg);
      throw new Error(msg);
    }
    return {};
  }
  return data;
}

/** Read `~/.sandbox/services.yaml` (whole document). Required — throws when absent. */
function servicesDoc({ required = true } = {}): Record<string, any> {
  return loadYaml(servicesYamlPath(), { required });
}

/**
 * Load the service registry from ~/.sandbox/services.yaml.
 *
 * services.yaml is a REQUIRED config: a missing or empty file throws
 * instead of silently proceeding with `{}` (DEBT-01 D-02/D-04) — a missing
 * service registry means generation cannot produce correct config.
 */
export function loadServices(): Record<string, any> {
  const data = servicesDoc();
  return data["services"] ?? data;
}

/**
 * Kube context for the dev cluster (services.yaml top-level `k8s_context`).
 *
 * Consumed by `sandbox intercept`. Required when interception is used, so a
 * missing key fails loud rather than defaulting to whatever kubectl context
 * happens to be current — intercepting the wrong cluster is the failure mode
 * this guards against.
 */
export function getK8sContext(): string {
  const data = servicesDoc();
  const context = data["k8s_context"];
  if (!context || typeof context !== "string") {
    throw new Error(
      "services.yaml has no top-level `k8s_context` key — add the dev " +
      "cluster kube context there (see docs/k8s-intercept.md).",
    );
  }
  return context;
}

/**
 * Load setup service definitions from config/services.yaml.
 *
 * Optional: returns `{}` when the file or the `setup_services` section
 * is absent.
 */
export function loadSetupServices(): Record<string, any> {
  const data = servicesDoc({ required: false });
  return data["setup_services"] ?? {};
}

/**
 * Load the `infrastructure:` block from config/services.yaml.
 *
 * Holds non-service infra (redis, postgres, mongodb). Any entry that carries
 * k8s-forward coordinates (`k8s_forward_port`) is picked up by the forward-table
 * generator, which reads this alongside loadServices(). Optional: returns `{}`
 * when absent.
 */
export function loadInfrastructure(): Record<string, any> {
  const data = servicesDoc({ required: false });
  return data["infrastructure"] ?? {};
}

/**
 * Load port allocation config from ~/.sandbox/ports.yaml.
 *
 * ports.yaml is a REQUIRED config: a missing or empty file throws instead
 * of silently proceeding with `{}` (DEBT-01 D-02/D-04) — slot allocation
 * and port math cannot proceed on empty config.
 */
export function loadPorts(): Record<string, any> {
  return loadYaml(portsYamlPath(), { required: true });
}

/**
 * Load the repo→services mapping from ~/.sandbox/services.yaml.
 *
 * Returns the `repos:` section, which maps each repo name to its list of
 * services and optional path_mappings.  Returns an empty dict if unavailable.
 */
export function loadReposConfig(): Record<string, any> {
  const data = servicesDoc({ required: false });
  return data["repos"] ?? {};
}

/**
 * Load the `archetypes:` registry from config/services.yaml.
 *
 * Maps archetype name → bundle dict (standards, mcp_servers, ...) — see
 * docs/jit-agents-and-tools-spec.md §4.1.  Returns an empty dict if
 * unavailable (a checkout that predates the registry): services then
 * resolve only through the legacy per-service `standards:` form.
 */
export function loadArchetypes(): Record<string, any> {
  const data = servicesDoc({ required: false });
  return data["archetypes"] ?? {};
}

/**
 * Load the `mcp_servers:` definition registry from config/services.yaml.
 *
 * Maps server name → verbatim .mcp.json server body — see
 * docs/jit-agents-and-tools-spec.md §4.5.  Returns an empty dict if
 * unavailable (a checkout that predates the registry): no MCP projection
 * happens.
 */
export function loadMcpServers(): Record<string, any> {
  const data = servicesDoc({ required: false });
  return data["mcp_servers"] ?? {};
}

/** Return a sorted list of all known service names. */
export function getServiceNames(): string[] {
  return Object.keys(loadServices()).sort();
}

/**
 * Return the sorted set of named-volume base names the registry declares.
 *
 * Compose generation isolates these per feature by prefixing the feature
 * name (`<feature>-<base>`), so this is exactly the set of suffixes that
 * identify a per-feature sandbox volume. Mirrors the volume collection in
 * generateFeatureCompose() and docker-compose.feature.yml.j2: every
 * `node_modules_volume`, plus every `extra_volumes` entry whose left side is
 * a named volume rather than a host bind mount (a "/" marks a bind mount) —
 * across both `services:` and `setup_services:`.
 */
export function getVolumeBaseNames(): string[] {
  const bases = new Set<string>();
  const collect = (defs: Record<string, unknown>): void => {
    for (const def of Object.values(defs)) {
      if (!isDict(def)) {
        continue;
      }
      const nodeModulesVol = def["node_modules_volume"];
      if (typeof nodeModulesVol === "string" && nodeModulesVol) {
        bases.add(nodeModulesVol);
      }
      const extraVolumes = def["extra_volumes"];
      if (!Array.isArray(extraVolumes)) {
        continue;
      }
      for (const spec of extraVolumes) {
        if (typeof spec !== "string") {
          continue;
        }
        const volName = spec.split(":")[0];
        if (volName && !volName.includes("/")) {
          bases.add(volName);
        }
      }
    }
  };
  collect(loadServices());
  collect(loadSetupServices());
  return [...bases].sort();
}
