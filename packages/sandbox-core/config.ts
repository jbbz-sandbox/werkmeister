/**
 * Machine-config locations and the registry semantics derived from them —
 * the layer BOTH the `sandbox` CLI (in-process) and sandbox-core (which also
 * drives the CLI as a subprocess) read.
 *
 * It exists because the two were resolving the same files independently and
 * disagreeing:
 *
 *  - sandbox-core looked up registry files by `SANDBOX_*_YAML` env var only, so
 *    an `overrides.services_yaml` in config.yaml was invisible to it whenever
 *    env.sh had not been sourced — which is exactly the Claude Desktop / MCP
 *    case, since those servers get a minimal env rather than a login shell;
 *  - the workspaces root was config-first in the CLI and env-first here;
 *  - the k8s-forward table and the feature-slot port math were parsed out of
 *    the same YAML by two hand-written parsers.
 *
 * Everything here is SYNCHRONOUS: the CLI's own config layer is sync top to
 * bottom, and making it await would ripple through every command. Async
 * callers lose nothing by calling a sync reader.
 *
 * Deliberately policy-free — it locates and parses, and never decides what a
 * missing file means. The CLI fails loud on a missing required registry; the
 * dashboard degrades to a null. That split stays with each caller.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { error, warn } from "./reporter.js";

/** Expand a leading `~` against the current user's home directory. */
export function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Path to the global config YAML.
 *
 * `SANDBOX_CONFIG_FILE` names *which* file to read — a location, not a value —
 * so "the YAML is the single source of truth" stays literally true and tests
 * can point the whole set at a temp dir.
 */
export function configPath(): string {
  const override = process.env.SANDBOX_CONFIG_FILE;
  return override ? expandUser(override) : path.join(os.homedir(), ".sandbox", "config.yaml");
}

/** The `~/.sandbox` directory, derived from {@link configPath} so both relocate together. */
export function sandboxHome(): string {
  return path.dirname(configPath());
}

function isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and parse the global config YAML.
 *
 * A missing file is normal (unconfigured machine) and yields `{}`; a file that
 * exists but does not parse throws, so callers can tell "nothing configured"
 * from "your config is broken" and report each in their own voice.
 */
export function loadConfig(): Record<string, any> {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  const data = parseYaml(fs.readFileSync(p, "utf8"));
  return isDict(data) ? data : {};
}

/**
 * Resolve one registry file: `overrides.<overrideKey>` → `$<envVar>` →
 * `~/.sandbox/<basename>`.
 *
 * The YAML override wins over the env var because env.sh is *generated from*
 * the YAML — when the two disagree, the export is the stale one. The env var
 * still ranks above the default so a process that only inherited env.sh (no
 * readable config.yaml) keeps working.
 *
 * An override that names a nonexistent file is returned anyway rather than
 * silently falling through to the default: reading a different registry than
 * the one you configured is the worse failure.
 */
function registryPath(overrideKey: string, envVar: string, basename: string): string {
  const override = (loadConfig()["overrides"] ?? {})[overrideKey];
  if (override) return path.resolve(expandUser(String(override)));
  const fromEnv = process.env[envVar];
  if (fromEnv) return path.resolve(expandUser(fromEnv));
  return path.join(sandboxHome(), basename);
}

/** Path to the service registry (`overrides.services_yaml` → `$SANDBOX_SERVICES_YAML` → ~/.sandbox/services.yaml). */
export function servicesYamlPath(): string {
  return registryPath("services_yaml", "SANDBOX_SERVICES_YAML", "services.yaml");
}

/** Path to the port allocation map (`overrides.ports_yaml` → `$SANDBOX_PORTS_YAML` → ~/.sandbox/ports.yaml). */
export function portsYamlPath(): string {
  return registryPath("ports_yaml", "SANDBOX_PORTS_YAML", "ports.yaml");
}

/** Path to the model pricing table (`overrides.model_pricing_yaml` → `$SANDBOX_MODEL_PRICING_YAML` → ~/.sandbox/model-pricing.yaml). */
export function modelPricingYamlPath(): string {
  return registryPath("model_pricing_yaml", "SANDBOX_MODEL_PRICING_YAML", "model-pricing.yaml");
}

/**
 * The directory holding per-feature workspaces: `paths.workspaces_root` →
 * `$SANDBOX_WORKSPACES_ROOT` → `~/workspace`.
 *
 * Same YAML-over-env precedence as {@link registryPath}, and here the YAML is
 * load-bearing rather than merely fresher: a GUI-launched process (the VS Code
 * extension host, Claude Desktop) never sourced env.sh at all, so the export it
 * would otherwise depend on does not exist.
 *
 * This is only the ROOT — resolving *which* workspace a cwd sits in is the
 * CLI's own concern (it also auto-detects from the git tree).
 */
export function workspacesRoot(): string {
  const configured = (loadConfig()["paths"] ?? {})["workspaces_root"];
  if (configured) return path.resolve(expandUser(String(configured)));
  const fromEnv = process.env.SANDBOX_WORKSPACES_ROOT;
  if (fromEnv) return path.resolve(expandUser(fromEnv));
  return path.join(os.homedir(), "workspace");
}

// ---------------------------------------------------------------------------
// Registry semantics
// ---------------------------------------------------------------------------
// Pure functions over an ALREADY-LOADED registry document. Loading it is the
// caller's job precisely because the two callers disagree about what an
// unreadable registry means.

export interface ForwardSpec {
  name: string;
  listen: number;
  remote: number;
  ns: string;
  prefix: string;
  health: string;
}

/**
 * The k8s port-forward table: one entry per forwarded service in services.yaml
 * order, then every `infrastructure:` entry declaring `k8s_forward_port`.
 *
 * A service is forwarded iff it declares `k8s_forward_port`. The forward *name*
 * is `k8s_forward_name` when set (an alias differing from the key), else the
 * key. `remote` is the in-pod container port (`internal_port`) for both kinds —
 * `kubectl port-forward deployment/x` binds a pod port, not the cluster-facing
 * Service port (`k8s_port`).
 */
export function forwardSpecs(
  services?: Record<string, any> | null,
  infrastructure?: Record<string, any> | null,
): ForwardSpec[] {
  const specs: ForwardSpec[] = [];
  const collect = (entries: Record<string, any> | null | undefined, nameKey: boolean) => {
    if (!isDict(entries)) return;
    for (const [key, def] of Object.entries(entries)) {
      if (!isDict(def) || def["k8s_forward_port"] === null || def["k8s_forward_port"] === undefined) {
        continue;
      }
      specs.push({
        name: (nameKey && def["k8s_forward_name"]) || key,
        listen: Number(def["k8s_forward_port"]),
        remote: def["internal_port"],
        ns: def["k8s_namespace"] || "",
        prefix: def["k8s_pod_prefix"] || "",
        health: def["health_endpoint"] || "",
      });
    }
  };
  collect(services, true);
  collect(infrastructure, false);
  return specs;
}

/**
 * The `[start, end]` host-port range for a feature slot, from an already-loaded
 * ports.yaml document (`feature_slots.base_port` / `.ports_per_slot`).
 *
 * The `* 100` slot stride is the fixed spacing between slot bases and is
 * independent of `ports_per_slot` (how many of those 100 a slot actually uses).
 * Example: slot 1 → [11100, 11119], slot 2 → [11200, 11219].
 */
export function slotPortRange(slot: number, ports?: Record<string, any> | null): [number, number] {
  const featureSlots = isDict(ports) && isDict(ports["feature_slots"]) ? ports["feature_slots"] : {};
  const base = featureSlots["base_port"] ?? 11100;
  const span = featureSlots["ports_per_slot"] ?? 20;
  const start = base + (slot - 1) * 100;
  return [start, start + span - 1];
}

/** The `paths:` block of the global config. */
function asDict(value: unknown): Record<string, string> {
  return isDict(value) ? (value as Record<string, string>) : {};
}

// ---------------------------------------------------------------------------
// Workspace resolution and the registry loaders
// ---------------------------------------------------------------------------
// Moved out of the CLI so the dashboard and the extension read the same
// registry through the same precedence, rather than shelling out for it.
//
// `sandboxRoot` / `infraRoot` came along later, at the foot of this file: the
// modules that need them moved here too, and a walk-up anchored on `apps/cli`
// answers the same question from either package.

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
  const value = asDict(loadConfig()["paths"])["repos_root"];
  if (value) {
    return path.resolve(expandUser(value));
  }
  return path.resolve(path.join(os.homedir(), "workspace"));
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
 *         repo-a/                             <- worktree (.git file)
 *         repo-b/                             <- worktree (.git file)
 *
 *     ~/workspace/                            <- workspace (single-repo)
 *         repo-a/                             <- repo (.git dir)
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

  const configured = asDict(loadConfig()["paths"])["workspaces_root"];
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
  const data = parseYaml(fs.readFileSync(filePath, "utf8"));
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
      "cluster kube context there (e.g. `k8s_context: orbstack`); " +
      "`kubectl config get-contexts` lists the available names.",
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
 * docs/jit-context-system.md §4.1.  Returns an empty dict if
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
 * docs/jit-context-system.md §5.5.  Returns an empty dict if
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
 * generateFeatureCompose() and docker-compose.feature.yml.njk: every
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

// ---------------------------------------------------------------------------
// Where the CLI checkout is
// ---------------------------------------------------------------------------

/**
 * The CLI package directory (`<checkout>/apps/cli`) — the root of everything
 * that ships as CODE: `infra/`, `dist/`, the `sandbox` wrapper.
 *
 * Resolution mirrors `resolveSandboxBin` in sandbox.ts because it answers the
 * same question: `SANDBOX_ROOT` first (the wrapper re-derives and exports it from
 * the *running* checkout, so it is authoritative and beats a nearer one on
 * disk), then a walk up from this module looking for the checkout that owns
 * `apps/cli`.
 *
 * The walk-up is what a bundled consumer cannot do — a `.vsix` has no monorepo
 * around it — which is why `SANDBOX_ROOT` ranks first rather than as a fallback.
 */
export function sandboxRoot(): string {
  const override = process.env.SANDBOX_ROOT;
  if (override) return path.resolve(expandUser(override));

  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    const cli = path.join(dir, "apps", "cli");
    if (fs.existsSync(cli)) return cli;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the sandbox CLI package. Set SANDBOX_ROOT to your " +
      "sandbox checkout's apps/cli directory.",
  );
}

/**
 * The `infra/` dir holding compose files, templates, the proxy UI, schemas and
 * skills. All versioned code — the machine-specific registry files live in
 * `~/.sandbox` instead, reached via {@link servicesYamlPath} and friends.
 */
export function infraRoot(): string {
  return path.join(sandboxRoot(), "infra");
}

/**
 * The monorepo root containing the CLI, not the CLI package itself.
 *
 * {@link sandboxRoot} returns `<repo>/apps/cli` — right for `infra/`, wrong for
 * resolving the sibling apps under `<repo>/apps/`. Walks up looking for `apps/`
 * rather than assuming a fixed depth, so a checkout laid out differently (or a
 * `SANDBOX_ROOT` already pointing at the repo root) still resolves.
 */
export function monorepoRoot(): string {
  let dir = sandboxRoot();
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
  return sandboxRoot();
}
