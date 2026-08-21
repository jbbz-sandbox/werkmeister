/**
 * Machine-config locations and the registry semantics derived from them —
 * the layer BOTH the `sandbox` CLI (in-process) and this driver (which also
 * drives the CLI as a subprocess) read.
 *
 * It exists because the two were resolving the same files independently and
 * disagreeing:
 *
 *  - the driver looked up registry files by `SANDBOX_*_YAML` env var only, so
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
 * driver degrades to a null. That split stays with each caller.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

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
