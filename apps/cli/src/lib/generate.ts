/**
 * File generation for per-feature Docker Compose, .env, supergraph, and Caddyfile.
 *
 * Uses nunjucks templates from the templates/ directory when available,
 * otherwise falls back to programmatic generation.
 *
 * As of Phase 3, the per-feature `docker-compose.yml` and `.env` are written
 * directly to the workspace root, while `supergraph-config.yml` lives in
 * `<workspace>/.sandbox/`. The legacy `<sandbox-root>/generated/` output
 * directory is no longer produced.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import nunjucks from "nunjucks";
import * as YAML from "yaml";

import { buildSandboxContextMd } from "./claude_md.js";
import {
  getInfraRoot,
  getSandboxRoot,
  info,
  loadPorts,
  loadServices,
  loadSetupServices,
  resolveWorkspace,
  success,
  warn,
} from "./config.js";
import { loadFeatureRouters } from "./feature_routing.js";
import { sandboxLock } from "./locks.js";
import { getSecretsPath, loadSecrets, requiredSecretKeys } from "./secrets.js";
import { allocateSlot, getAllSlots, getPortRange, getServicePort } from "./slots.js";

function isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** jinja truthiness: empty dicts/lists are falsy (JS objects are always truthy). */
function jinjaTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function setdefault(obj: Record<string, any>, key: string, value: any): void {
  if (!(key in obj)) {
    obj[key] = value;
  }
}

/**
 * Return the absolute host path of a git worktree's admin dir, if any.
 *
 * When a repo checkout is a linked git worktree (created via `git worktree
 * add`), its `.git` is a *file* containing `gitdir: <path>` pointing at
 * the main repo's `.git/worktrees/<name>`. That admin dir lives outside the
 * mounted checkout, so git commands inside the container fail to resolve the
 * worktree unless it's bind-mounted at the same absolute path.
 *
 * Returns the gitdir path (string) that needs mounting, or `null` when `.git`
 * is a normal directory (a non-worktree checkout needs no extra mount).
 */
function resolveWorktreeGitdir(repoCheckoutPath: string): string | null {
  const gitPath = path.join(repoCheckoutPath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  for (const line of fs.readFileSync(gitPath, "utf8").split("\n")) {
    if (line.startsWith("gitdir:")) {
      const gitdir = line.slice(line.indexOf(":") + 1).trim();
      // Only mount when the admin dir is outside the checkout tree
      // (always true for worktrees; the pointer is absolute).
      const rel = path.relative(repoCheckoutPath, gitdir);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return gitdir;
      }
    }
  }
  return null;
}

/**
 * Return concrete `[servicesConfig, portsConfig]` dicts.
 *
 * Uses *config*'s `"services"`/`"ports"` entries when present and
 * non-empty, otherwise falls back to loading them directly. This keeps the
 * return type a concrete dict (never null) now that `loadServices`/
 * `loadPorts` themselves return concrete dicts (DEBT-01).
 */
function resolveServicesAndPorts(
  config: Record<string, any> | null | undefined,
): [Record<string, any>, Record<string, any>] {
  const servicesFromConfig = config ? config["services"] : null;
  const portsFromConfig = config ? config["ports"] : null;
  const servicesConfig = jinjaTruthy(servicesFromConfig) ? servicesFromConfig : loadServices();
  const portsConfig = jinjaTruthy(portsFromConfig) ? portsFromConfig : loadPorts();
  return [servicesConfig, portsConfig];
}

// ---------------------------------------------------------------------------
// nunjucks environment — jinja2 compatibility layer
// ---------------------------------------------------------------------------
//
// The templates on disk are written in the jinja2 dialect, so the nunjucks
// replicates the jinja2 `Environment` options and papers over the jinja/Python
// idioms the templates rely on:
//
// - jinja2 options were `keep_trailing_newline=True` + `jinja2.ext.do`, with
//   trim_blocks/lstrip_blocks/autoescape left at their (False) defaults.
//   nunjucks always keeps the trailing newline and defaults trimBlocks/
//   lstripBlocks to false, so only `autoescape: false` needs setting
//   (nunjucks defaults it to true) plus a custom `{% do %}` tag.
// - `list.append(...)` inside `{% do %}` operates on arrays the template
//   itself creates with `{% set x = [] %}` — provided via a non-enumerable
//   Array.prototype.append.
// - `dict.get(key, default)` / `dict.items()` on context data — provided by
//   `jinjaContext`, which stamps non-enumerable methods on plain objects.
// - jinja's `map(attribute=...)` filter has no nunjucks equivalent — added.
// - jinja treats empty dicts/lists as falsy in `{% if %}`; JS does not. The
//   loader rewrites every if/elif condition to `__truthy(<expr>)` (a template
//   global) at load time — templates on disk stay byte-identical.

class DoExtension {
  tags = ["do"];

  parse(parser: any, nodes: any): any {
    const tok = parser.nextToken();
    const args = parser.parseSignature(null, true);
    parser.advanceAfterBlockEnd(tok.value);
    return new nodes.CallExtension(this, "run", args);
  }

  // Evaluating the args is the whole point (e.g. `arr.append(x)`); emit nothing.
  run(..._args: unknown[]): string {
    return "";
  }
}

const _IF_CONDITION_RE = /(\{%-?\s*(?:el)?if\s+)([\s\S]+?)(\s*-?%\})/g;

/** FileSystemLoader that rewrites if-conditions for jinja truthiness. */
class JinjaCompatLoader extends (nunjucks.FileSystemLoader as any) {
  getSource(name: string): any {
    const source = super.getSource(name);
    if (source && typeof source.src === "string") {
      source.src = source.src.replace(
        _IF_CONDITION_RE,
        (_m: string, open: string, cond: string, close: string) =>
          `${open}__truthy(${cond})${close}`,
      );
    }
    return source;
  }
}

const _DICT_GET = function (this: Record<string, any>, key: string, dflt?: any): any {
  return key in this ? this[key] : dflt;
};
const _DICT_ITEMS = function (this: Record<string, any>): Array<[string, any]> {
  return Object.entries(this);
};

/** Recursively stamp the dict methods jinja templates call (`get`, `items`). */
function jinjaContext<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const obj = value as unknown as object;
  if (seen.has(obj)) {
    return value;
  }
  seen.add(obj);
  if (Array.isArray(value)) {
    for (const item of value) {
      jinjaContext(item, seen);
    }
    return value;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto === Object.prototype || proto === null) {
    const record = value as unknown as Record<string, any>;
    if (!Object.prototype.hasOwnProperty.call(record, "get")) {
      Object.defineProperty(record, "get", { value: _DICT_GET, enumerable: false });
    }
    if (!Object.prototype.hasOwnProperty.call(record, "items")) {
      Object.defineProperty(record, "items", { value: _DICT_ITEMS, enumerable: false });
    }
    for (const v of Object.values(record)) {
      jinjaContext(v, seen);
    }
  }
  return value;
}

function installArrayAppend(): void {
  // ponytail: non-enumerable Array.prototype patch so `{% set x = [] %}` +
  // `{% do x.append(y) %}` works; swap for a template preprocessor only if
  // this ever collides with another `append`.
  if (!Object.prototype.hasOwnProperty.call(Array.prototype, "append")) {
    Object.defineProperty(Array.prototype, "append", {
      value: function append(this: unknown[], item: unknown): void {
        this.push(item);
      },
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

/** Create and return a nunjucks `Environment` (jinja2-parity settings). */
function getNunjucksEnv(): nunjucks.Environment {
  installArrayAppend();
  const templatesDir = path.join(getInfraRoot(), "templates");
  if (!fs.existsSync(templatesDir) || !fs.statSync(templatesDir).isDirectory()) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }
  const env = new nunjucks.Environment(new (JinjaCompatLoader as any)(templatesDir), {
    autoescape: false,
  });
  env.addExtension("do", new DoExtension() as any);
  env.addGlobal("__truthy", jinjaTruthy);
  // jinja `map(attribute='name')` — the only form the templates use.
  env.addFilter("map", (arr: any[], kwargs: any) => {
    const attr = kwargs && typeof kwargs === "object" ? kwargs["attribute"] : undefined;
    return (arr ?? []).map((item) => (attr === undefined ? item : item[attr]));
  });
  return env;
}

/** getTemplate, or `null` on TemplateNotFound (any other error propagates). */
function getTemplateOrNull(env: nunjucks.Environment, name: string): nunjucks.Template | null {
  try {
    return env.getTemplate(name);
  } catch (err) {
    if (err instanceof Error && /template not found/i.test(err.message)) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------

function composeHeader(feature: string, source: string): string {
  return (
    `# Sandbox docker-compose for feature: ${feature}\n` +
    `# Generated by: ${source}\n` +
    "#\n" +
    "# Run from workspace root:\n" +
    "#   docker compose up -d --build   (start)\n" +
    "#   docker compose down            (stop)\n" +
    "#   docker compose logs -f         (tail logs)\n" +
    "#   docker compose ps              (status)\n" +
    "#\n"
  );
}

/** Return `[workspaceRoot, outPath]` for the generated compose file. */
function resolveComposeOutPath(
  feature: string,
  workspaceOverride: string | null | undefined,
): [string, string] {
  const workspaceRoot = resolveWorkspace(feature, workspaceOverride);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return [workspaceRoot, path.join(workspaceRoot, "docker-compose.yml")];
}

/**
 * Seed workspace metadata into `<workspace>/.env`, keeping existing keys.
 *
 * `init-workspace` calls this before the generator runs. It must preserve
 * like `writeWorkspaceEnv` does: this write lands first, so anything it
 * drops is already gone by the time the generator reads the file back to
 * preserve it.
 */
export function seedWorkspaceMetadataEnv(envPath: string, meta: Record<string, string>): void {
  const body = Object.entries(meta)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  fs.writeFileSync(envPath, preservedEnvMetadata(envPath, new Set(Object.keys(meta))) + body);
}

/**
 * Return a header of workspace-metadata env lines preserved across regen.
 *
 * Reads `<workspace>/.env` if it exists and returns any non-comment
 * `key=value` lines whose key is not in *generatedKeys*. The header is
 * formatted ready to prepend to a freshly generated .env body.
 */
function preservedEnvMetadata(envPath: string, generatedKeys: Set<string>): string {
  let existing: string;
  try {
    if (!fs.statSync(envPath).isFile()) {
      return "";
    }
    existing = fs.readFileSync(envPath, "utf8");
  } catch {
    return "";
  }
  const preserved: string[] = [];
  for (const line of existing.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) {
      continue;
    }
    const key = stripped.slice(0, stripped.indexOf("=")).trim();
    if (!generatedKeys.has(key)) {
      preserved.push(line);
    }
  }
  if (preserved.length === 0) {
    return "";
  }
  return "# Workspace metadata (preserved across regeneration)\n" + preserved.join("\n") + "\n\n";
}

/**
 * Look up the `k8s-forwards` container listen-port for a service.
 *
 * Reads `k8s_forward_port` from the service definition in services.yaml —
 * the single source of truth for the 9000-range port a remote service is
 * reached on (`k8s-forwards:<port>`). Returns `null` when the service has
 * no forward (e.g. storybook), which callers treat as unresolvable.
 *
 * `portsConfig` is retained for signature stability but no longer read
 * (the former `ports.yaml k8s_forwards` map was folded into services.yaml).
 */
function k8sPortForService(
  serviceName: string,
  servicesConfig: Record<string, any>,
  _portsConfig: Record<string, any>,
): number | null {
  const svcDef = servicesConfig[serviceName] ?? {};
  if (isDict(svcDef) && svcDef["k8s_forward_port"] !== null && svcDef["k8s_forward_port"] !== undefined) {
    return Number(svcDef["k8s_forward_port"]);
  }
  return null;
}

/** Single-quote a value for an error message. */
function quoted(value: string): string {
  return `'${value}'`;
}

/**
 * Replace `{service-name}` placeholders in environment values.
 *
 * If the referenced service is running locally, use its Docker network alias
 * and internal port.  Otherwise use the `k8s-forwards` container with the
 * appropriate port.
 *
 * Note: this pattern is distinct from the `${ENV_VAR}` shell-interpolation
 * syntax also used in services.yaml (e.g. `"${GITHUB_AUTH_TOKEN}"`) -- the
 * negative lookbehind below excludes any `{...}` immediately preceded by
 * `$` so shell-style env references are left untouched.
 */
function resolveServiceRefs(
  value: string,
  localServices: string[],
  servicesConfig: Record<string, any>,
  portsConfig: Record<string, any>,
): string {
  return value.replace(/(?<!\$)\{([a-zA-Z0-9_-]+)\}/g, (_match, svcName: string) => {
    const svcDef = servicesConfig[svcName] ?? {};
    if (!isDict(svcDef)) {
      throw new Error(
        `Cannot resolve {${svcName}} in ${quoted(value)}: ` +
        `${quoted(svcName)} is not a known service in services.yaml`,
      );
    }

    if (localServices.includes(svcName)) {
      // Use Docker network alias + internal port
      const internalPort = svcDef["internal_port"] ?? 3000;
      return `${svcName}:${internalPort}`;
    }
    // Use k8s-forwards container on the shared Docker network
    const k8sPort = k8sPortForService(svcName, servicesConfig, portsConfig);
    if (k8sPort) {
      return `k8s-forwards:${k8sPort}`;
    }
    throw new Error(
      `Cannot resolve {${svcName}} in ${quoted(value)}: ` +
      `${quoted(svcName)} is not local and has no k8s_forward_port in services.yaml`,
    );
  });
}

// ---------------------------------------------------------------------------
// Docker Compose generation
// ---------------------------------------------------------------------------

/**
 * Read a dict-valued *field* from `.sandbox/workspace.yml` under *workspaceRoot*.
 *
 * Absent field, missing or malformed file -> `{}` so workspaces that have not
 * opted in render identically.
 */
function loadWorkspaceDict(workspaceRoot: string, field: string): Record<string, any> {
  const configPath = path.join(workspaceRoot, ".sandbox", "workspace.yml");
  let text: string;
  try {
    if (!fs.statSync(configPath).isFile()) {
      return {};
    }
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  let data: any;
  try {
    data = YAML.parse(text) ?? {};
  } catch {
    return {};
  }
  if (!isDict(data)) {
    data = {};
  }
  const value = field in data ? data[field] : {};
  return isDict(value) ? value : {};
}

/**
 * Per-workspace dev-link bind mounts from `.sandbox/workspace.yml`.
 *
 * Maps service name -> list of `"host:container[:ro]"` specs (same grammar
 * as services.yaml `extra_volumes`), letting a workspace mount a locally
 * built package over its `node_modules` copy without editing the global
 * service registry (PROJ-1897 — see .sandbox/notes/008).
 */
function loadDevLinks(workspaceRoot: string): Record<string, string[]> {
  return loadWorkspaceDict(workspaceRoot, "dev_links");
}

/**
 * Generate `<workspace>/docker-compose.yml` for *feature*.
 *
 * Parameters
 * ----------
 * feature
 *     Feature name.
 * slot
 *     Allocated slot number (1-12).
 * localServices
 *     Service names to run locally.
 * config
 *     Pre-loaded merged config. If null, loads from disk.
 * workspaceOverride
 *     Explicit workspace path. If null, resolved from cwd / env vars.
 * source
 *     Human-readable name of the command that triggered generation
 *     (used in the header comment).
 *
 * Returns the path to the generated workspace docker-compose.yml.
 */
export function generateFeatureCompose(
  feature: string,
  slot: number,
  localServices: string[],
  config: Record<string, any> | null = null,
  workspaceOverride: string | null = null,
  source = "sandbox CLI",
): string {
  const [servicesConfig, portsConfig] = resolveServicesAndPorts(config);
  const [workspaceRoot, outPath] = resolveComposeOutPath(feature, workspaceOverride);
  const devLinks = loadDevLinks(workspaceRoot);
  const header = composeHeader(feature, source);

  // Try template first
  const jinjaEnv = getNunjucksEnv();
  const template = getTemplateOrNull(jinjaEnv, "docker-compose.feature.yml.njk");
  if (template) {
    const [portStart] = getPortRange(slot);
    // Build rich service objects for the template
    const svcObjects: Record<string, any>[] = [];
    for (const svcName of [...localServices].sort()) {
      const svcDef = servicesConfig[svcName] ?? {};
      if (!isDict(svcDef)) {
        continue;
      }
      const svcObj: Record<string, any> = { ...svcDef };
      svcObj["name"] = svcName;
      setdefault(svcObj, "port_offset", 0);
      setdefault(svcObj, "internal_port", 3000);
      setdefault(svcObj, "setup_service", null);
      setdefault(svcObj, "node_modules_volume", null);
      setdefault(svcObj, "extra_volumes", []);
      svcObj["dev_links"] = devLinks[svcName] ?? [];
      setdefault(svcObj, "environment", {});
      // Resolve {service-name} placeholders in env values
      const resolvedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(svcObj["environment"] as Record<string, string>)) {
        resolvedEnv[k] = resolveServiceRefs(v, localServices, servicesConfig, portsConfig);
      }
      svcObj["environment"] = resolvedEnv;
      setdefault(svcObj, "command", null);
      setdefault(svcObj, "memory_limit", "2G");
      setdefault(svcObj, "memory_reservation", "512M");
      setdefault(svcObj, "health_endpoint", "/health");
      setdefault(svcObj, "extra_services", null);
      setdefault(svcObj, "depends_on", []);
      svcObj["worktree_gitdir"] = resolveWorktreeGitdir(
        path.join(workspaceRoot, svcObj["repo"] ?? ""),
      );
      svcObjects.push(svcObj);
    }
    // Load setup service configs
    let setupConfigs: Record<string, any> =
      config && "setup_services" in config ? config["setup_services"] ?? {} : loadSetupServices();
    // Copy + annotate each setup config with its worktree gitdir (if the
    // repo checkout is a linked worktree) so the template can mount it.
    setupConfigs = Object.fromEntries(
      Object.entries(setupConfigs).map(([name, cfg]) => [
        name,
        {
          // Setup configs never went through the `setdefault` pass the services
          // above get, but the template dereferences these unguarded: a missing
          // memory_limit renders `memory:` with no value and compose rejects the
          // whole file. `image` is not here — the template's own `| default`
          // covers it.
          memory_limit: "2G",
          memory_reservation: "512M",
          extra_volumes: [],
          // One-shot: dependents wait on service_completed_successfully, never
          // on health, but the template emits the healthcheck unconditionally.
          healthcheck: "true",
          ...(cfg as Record<string, any>),
          worktree_gitdir: resolveWorktreeGitdir(
            path.join(workspaceRoot, (cfg as Record<string, any>)["repo"] ?? ""),
          ),
        },
      ]),
    );
    let rendered = template.render(
      jinjaContext({
        feature_name: feature,
        slot,
        base_port: portStart,
        local_services: svcObjects,
        services_config: servicesConfig,
        setup_configs: setupConfigs,
        ports_config: portsConfig,
        workspace_path: workspaceRoot,
        sandbox_root: getSandboxRoot(),
        get_service_port: getServicePort,
        k8s_port_for_service: (s: string) => k8sPortForService(s, servicesConfig, portsConfig),
      }),
    );
    // Collapse runs of 3+ blank lines left behind by template logic blocks.
    rendered = rendered.replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(outPath, header + rendered);
    success(`Generated compose (template): ${outPath}`);
    return outPath;
  }
  warn(
    "Template 'docker-compose.feature.yml.njk' not found -- " +
    "falling back to built-in compose generation",
  );

  // ---- Programmatic generation -----------------------------------------
  getPortRange(slot);
  const networkName = `sandbox-${feature}`;

  const compose: Record<string, any> = {
    name: `sandbox-${feature}`,
    networks: {
      [`feature-${feature}`]: {
        name: networkName,
        driver: "bridge",
      },
      "shared-network": {
        external: true,
        name: "sandbox-shared",
      },
    },
    services: {},
  };

  // Collect named volumes that need per-feature isolation
  const namedVolumes: Record<string, Record<string, any>> = {};

  const sortedServices = [...localServices].sort();
  for (let idx = 0; idx < sortedServices.length; idx++) {
    const svcName = sortedServices[idx];
    const svcDef = servicesConfig[svcName] ?? {};
    if (!isDict(svcDef)) {
      continue;
    }

    const repo = svcDef["repo"] ?? "";
    const svcPath = svcDef["path"] ?? ".";
    const portOffset = svcDef["port_offset"] ?? idx;
    const internalPort = svcDef["internal_port"] ?? 3000;
    const hostPort = getServicePort(slot, portOffset);

    const contextPath = repo ? path.join(workspaceRoot, repo) : workspaceRoot;
    let dockerfile = svcDef["dockerfile"] ?? "Dockerfile";
    if (svcPath && svcPath !== "." && svcPath !== "/") {
      dockerfile = `${svcPath}/${dockerfile}`;
    }

    // Build environment: local services use Docker DNS aliases,
    // remote services use the k8s-forwards container
    const environment: Record<string, string> = {
      NODE_ENV: "development",
      SANDBOX_FEATURE: feature,
      SANDBOX_SLOT: String(slot),
    };

    for (const [otherSvc, otherDef] of Object.entries(servicesConfig)) {
      if (!isDict(otherDef)) {
        continue;
      }
      const envPrefix = otherSvc.toUpperCase().replace(/-/g, "_");
      if (localServices.includes(otherSvc)) {
        const otherInternalPort = otherDef["internal_port"] ?? 3000;
        environment[`${envPrefix}_URL`] = `http://${otherSvc}:${otherInternalPort}`;
      } else {
        const k8sPort = k8sPortForService(otherSvc, servicesConfig, portsConfig);
        if (k8sPort) {
          environment[`${envPrefix}_URL`] = `http://k8s-forwards:${k8sPort}`;
        }
      }
    }

    const serviceEntry: Record<string, any> = {
      build: {
        context: contextPath,
        dockerfile,
        target: "development",
      },
      container_name: `sandbox-${feature}-${svcName}`,
      labels: {
        "com.sandbox.local.feature": feature,
        "com.sandbox.local.slot": String(slot),
        "com.sandbox.local.service": svcName,
        "com.sandbox.local.role": "app",
      },
      ports: [`${hostPort}:${internalPort}`],
      environment,
      networks: {
        [`feature-${feature}`]: { aliases: [svcName] },
        "shared-network": { aliases: [`${feature}-${svcName}`] },
      },
      restart: "unless-stopped",
    };

    // Volume mounts — per-feature named volumes for node_modules/caches,
    // bind mounts for source code hot-reload
    const volumes: string[] = [];

    // node_modules volume (per-feature to avoid cross-feature corruption)
    const nodeModulesVol = svcDef["node_modules_volume"];
    if (nodeModulesVol) {
      const prefixed = `${feature}-${nodeModulesVol}`;
      volumes.push(`${prefixed}:/app/node_modules`);
      namedVolumes[prefixed] = { name: prefixed };
    }

    // Extra named volumes (caches, etc.) — per-feature prefixed
    for (const volSpec of svcDef["extra_volumes"] ?? []) {
      const parts = (volSpec as string).split(":");
      const volName = parts[0];
      if (volName.includes("/")) {
        // Host bind mount (e.g., "${REPO}/.git:/app/.git:ro") — resolve variables
        let resolved = (volSpec as string).split("${WORKSPACE}").join(workspaceRoot);
        resolved = resolved.split("${REPO}").join(path.join(workspaceRoot, repo));
        resolved = resolved.split("${SANDBOX_ROOT}").join(getSandboxRoot());
        volumes.push(resolved);
      } else {
        // Named volume — prefix with feature name
        const prefixed = `${feature}-${volName}`;
        const rest = parts.slice(1).join(":");
        volumes.push(`${prefixed}:${rest}`);
        namedVolumes[prefixed] = { name: prefixed };
      }
    }

    // Per-workspace dev-links (note 008): mount a locally built package over
    // its node_modules copy. Always host bind mounts (left side has a "/"),
    // so only variable substitution applies — no named-volume branch.
    for (const volSpec of devLinks[svcName] ?? []) {
      let resolved = volSpec.split("${WORKSPACE}").join(workspaceRoot);
      resolved = resolved.split("${REPO}").join(path.join(workspaceRoot, repo));
      resolved = resolved.split("${SANDBOX_ROOT}").join(getSandboxRoot());
      volumes.push(resolved);
    }

    // Source code bind mount for hot-reload
    if (svcPath && svcPath !== "." && svcPath !== "/") {
      const srcMount = path.join(workspaceRoot, repo, svcPath, "src");
      volumes.push(`${srcMount}:/app/src`);
    } else if (repo) {
      const srcMount = path.join(workspaceRoot, repo, "src");
      volumes.push(`${srcMount}:/app/src`);
    }

    if (volumes.length > 0) {
      serviceEntry["volumes"] = volumes;
    }

    // Service dependencies (setup service + local runtime dependencies).
    // One-shot setup containers must run to completion; long-running service
    // deps must be up AND healthy. Using service_completed_successfully on a
    // server that never exits leaves the dependent stuck in `Created`.
    const allDeps: Record<string, Record<string, string>> = {};
    if (svcDef["setup_service"]) {
      allDeps[svcDef["setup_service"]] = { condition: "service_completed_successfully" };
    }
    // Only include dependencies that are local services or extra_services
    for (const dep of svcDef["depends_on"] ?? []) {
      let depIsLocal = false;
      // Check if dependency is a local service
      if (localServices.includes(dep)) {
        depIsLocal = true;
      } else {
        // Check if dependency is an extra_service of a local service
        for (const otherSvc of localServices) {
          const otherDef = servicesConfig[otherSvc] ?? {};
          if (isDict(otherDef) && (otherDef["extra_services"] ?? {})[dep]) {
            depIsLocal = true;
            break;
          }
        }
      }
      if (depIsLocal && !(dep in allDeps)) {
        allDeps[dep] = { condition: "service_healthy" };
      }
    }
    if (Object.keys(allDeps).length > 0) {
      serviceEntry["depends_on"] = allDeps;
    }

    compose["services"][svcName] = serviceEntry;
  }

  // Declare all per-feature named volumes at top level
  if (Object.keys(namedVolumes).length > 0) {
    compose["volumes"] = namedVolumes;
  }

  // Write as YAML prefixed with the workspace header. indentSeq/singleQuote
  // keep the block-style shape the generated compose files already have.
  const body = YAML.stringify(compose, { indentSeq: false, singleQuote: true });
  fs.writeFileSync(outPath, header + body);

  success(`Generated compose (built-in): ${outPath}`);
  return outPath;
}

// ---------------------------------------------------------------------------
// .env generation
// ---------------------------------------------------------------------------

// Suffix mapping used by `avoidComposeEnvShadowing` to rename
// auto-generated service URL keys that collide with per-service
// `environment:` overrides in the generated docker-compose.yml.
const _BASE_SUFFIX_MAP: Record<string, string> = {
  _URL: "_BASE_URL",
  _HOST: "_BASE_HOST",
  _PORT: "_BASE_PORT",
};

/**
 * Rename any auto-generated service-URL key that a local service overrides
 * via its docker-compose `environment:` block, to a `*_BASE_*` form.
 *
 * Compose `environment:` always wins over `env_file: .env`. Before this
 * rename, a key like `REST_HELLO_URL` in `.env` was silently shadowed by a
 * consuming service's compose override, so the `.env` value was dead weight
 * inside the container and misleading to anyone reading `.env` to understand
 * what a service sees.
 *
 * The rename produces `REST_HELLO_BASE_URL` (etc.) in `.env`, keeping
 * the default value inspectable as a reference while leaving the service's
 * overridden `REST_HELLO_URL` unambiguous.
 */
function avoidComposeEnvShadowing(
  serviceUrls: Record<string, string>,
  localServices: string[],
  servicesConfig: Record<string, any>,
): Record<string, string> {
  const overriddenKeys = new Set<string>();
  for (const svcName of localServices) {
    const svcDef = servicesConfig[svcName] ?? {};
    if (isDict(svcDef)) {
      for (const key of Object.keys(svcDef["environment"] ?? {})) {
        overriddenKeys.add(key);
      }
    }
  }

  const renamed: Record<string, string> = {};
  for (const [key, value] of Object.entries(serviceUrls)) {
    if (overriddenKeys.has(key)) {
      let matched = false;
      for (const [suffix, newSuffix] of Object.entries(_BASE_SUFFIX_MAP)) {
        if (key.endsWith(suffix)) {
          renamed[key.slice(0, -suffix.length) + newSuffix] = value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        renamed[key] = value;
      }
    } else {
      renamed[key] = value;
    }
  }
  return renamed;
}

/**
 * Generate `<workspace>/.env` for *feature*.
 *
 * Contains all service URLs, slot info, and shared environment variables
 * needed by the feature's containers. Workspace metadata keys (e.g.
 * `FEATURE`, `SERVICES`, `JIRA_ID`, `TEST_PATH`) written by
 * `init-workspace` and not part of the generated body are preserved
 * across regeneration.
 */
export function generateFeatureEnv(
  feature: string,
  slot: number,
  localServices: string[],
  config: Record<string, any> | null = null,
  workspaceOverride: string | null = null,
): string {
  const [servicesConfig, portsConfig] = resolveServicesAndPorts(config);
  const workspaceRoot = resolveWorkspace(feature, workspaceOverride);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const outPath = path.join(workspaceRoot, ".env");
  const legacyEnv = path.join(workspaceRoot, "docker-compose.env");

  // Try template
  const jinjaEnv = getNunjucksEnv();
  const template = getTemplateOrNull(jinjaEnv, "env.njk");
  if (template) {
    const [portStart] = getPortRange(slot);
    // Build service_urls and env_vars for the template
    let serviceUrls: Record<string, string> = {};
    // Per-workspace overrides from `.sandbox/workspace.yml` (`env_vars:`). Rendered
    // last so a workspace can override a generated service URL or a secret value.
    const envVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(loadWorkspaceDict(workspaceRoot, "env_vars"))) {
      envVars[key] = String(value);
    }
    for (const svcName of Object.keys(servicesConfig).sort()) {
      const svcDef = servicesConfig[svcName] ?? {};
      if (!isDict(svcDef)) {
        continue;
      }
      const envPrefix = svcName.toUpperCase().replace(/-/g, "_");
      const internalPort = svcDef["internal_port"] ?? 3000;
      if (localServices.includes(svcName)) {
        // Local services: use Docker DNS alias on shared network
        serviceUrls[`${envPrefix}_URL`] = `http://${svcName}:${internalPort}`;
        serviceUrls[`${envPrefix}_HOST`] = svcName;
        serviceUrls[`${envPrefix}_PORT`] = String(internalPort);
      } else {
        // Remote services: use k8s-forwards container
        const k8sPort = k8sPortForService(svcName, servicesConfig, portsConfig);
        if (k8sPort) {
          serviceUrls[`${envPrefix}_URL`] = `http://k8s-forwards:${k8sPort}`;
          serviceUrls[`${envPrefix}_HOST`] = "k8s-forwards";
          serviceUrls[`${envPrefix}_PORT`] = String(k8sPort);
        }
      }
    }
    serviceUrls = avoidComposeEnvShadowing(serviceUrls, localServices, servicesConfig);
    // Load secrets from ~/.sandbox/secrets.env if it exists, narrowed to the keys
    // the feature's own local services declare via services.yaml `secrets:`. The
    // global file is shared across every workspace; only the declared subset has
    // any business being written into this feature's .env.
    const allSecrets = loadSecrets(getSecretsPath());
    const secrets: Record<string, string> = {};
    for (const key of requiredSecretKeys(servicesConfig, localServices)) {
      if (key in allSecrets) {
        secrets[key] = allSecrets[key];
      }
    }
    const rendered = template.render(
      jinjaContext({
        feature_name: feature,
        slot,
        base_port: portStart,
        service_urls: serviceUrls,
        env_vars: envVars,
        secrets,
      }),
    );
    writeWorkspaceEnv(outPath, rendered, legacyEnv);
    success(`Generated .env (template): ${outPath}`);
    return outPath;
  }
  warn("Template 'env.njk' not found -- " + "falling back to built-in .env generation");

  // ---- Programmatic generation -----------------------------------------
  const lines: string[] = [
    `# Auto-generated .env for feature: ${feature}`,
    `# Slot: ${slot}`,
    "",
    `SANDBOX_FEATURE=${feature}`,
    `SANDBOX_SLOT=${slot}`,
    `COMPOSE_PROJECT_NAME=sandbox-${feature}`,
    "",
    "# Service URLs",
  ];

  let fallbackUrls: Record<string, string> = {};
  for (const svcName of Object.keys(servicesConfig).sort()) {
    const svcDef = servicesConfig[svcName] ?? {};
    if (!isDict(svcDef)) {
      continue;
    }
    const envPrefix = svcName.toUpperCase().replace(/-/g, "_");

    if (localServices.includes(svcName)) {
      const internalPort = svcDef["internal_port"] ?? 3000;
      fallbackUrls[`${envPrefix}_URL`] = `http://${svcName}:${internalPort}`;
      fallbackUrls[`${envPrefix}_HOST`] = svcName;
      fallbackUrls[`${envPrefix}_PORT`] = String(internalPort);
    } else {
      const k8sPort = k8sPortForService(svcName, servicesConfig, portsConfig);
      if (k8sPort) {
        fallbackUrls[`${envPrefix}_URL`] = `http://k8s-forwards:${k8sPort}`;
        fallbackUrls[`${envPrefix}_HOST`] = "k8s-forwards";
        fallbackUrls[`${envPrefix}_PORT`] = String(k8sPort);
      }
    }
  }

  fallbackUrls = avoidComposeEnvShadowing(fallbackUrls, localServices, servicesConfig);
  for (const [key, value] of Object.entries(fallbackUrls)) {
    lines.push(`${key}=${value}`);
  }

  lines.push("");
  writeWorkspaceEnv(outPath, lines.join("\n") + "\n", legacyEnv);
  success(`Generated .env (built-in): ${outPath}`);
  return outPath;
}

/**
 * Write a generated .env body to *outPath*, preserving workspace metadata.
 *
 * Any `key=value` lines that exist in the current `<workspace>/.env`
 * but are NOT produced by the generator (e.g. `FEATURE`, `SERVICES`,
 * `JIRA_ID`, `TEST_PATH` written by `init-workspace`) are prepended
 * as a "Workspace metadata" header so they survive regeneration.
 *
 * A legacy `<workspace>/docker-compose.env` from previous CLI versions
 * is removed if found.
 */
function writeWorkspaceEnv(outPath: string, generatedBody: string, legacyEnv: string): void {
  const generatedKeys = new Set<string>();
  for (const line of generatedBody.split("\n")) {
    if (line.includes("=") && !line.trimStart().startsWith("#")) {
      generatedKeys.add(line.slice(0, line.indexOf("=")).trim());
    }
  }
  const header = preservedEnvMetadata(outPath, generatedKeys);
  fs.writeFileSync(outPath, header + generatedBody);
  let legacyIsFile = false;
  try {
    legacyIsFile = fs.statSync(legacyEnv).isFile();
  } catch {
    /* absent */
  }
  if (legacyIsFile) {
    fs.unlinkSync(legacyEnv);
    info(`Removed legacy ${path.basename(legacyEnv)}`);
  }
}

// ---------------------------------------------------------------------------
// Supergraph config generation
// ---------------------------------------------------------------------------

const _GRAPHQL_TYPES = new Set(["graphql-subgraph", "graphql", "subgraph", "federation"]);

/**
 * Generate `<workspace>/.sandbox/supergraph-config.yml` for *feature*.
 *
 * Maps each GraphQL subgraph service to either its local port (if running
 * locally) or its k8s port-forward port.
 */
export function generateSupergraphConfig(
  feature: string,
  slot: number,
  localServices: string[],
  config: Record<string, any> | null = null,
  workspaceOverride: string | null = null,
): string {
  const [servicesConfig, portsConfig] = resolveServicesAndPorts(config);
  const workspaceRoot = resolveWorkspace(feature, workspaceOverride);
  const sandboxDir = path.join(workspaceRoot, ".sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  const outPath = path.join(sandboxDir, "supergraph-config.yml");

  // Try template
  const jinjaEnv = getNunjucksEnv();
  const template = getTemplateOrNull(jinjaEnv, "supergraph-config.yml.njk");
  if (template) {
    const subgraphList: Array<{ name: string; url: string }> = [];
    for (const [svcName, svcDef] of Object.entries(servicesConfig)) {
      if (!isDict(svcDef)) {
        continue;
      }
      if (!_GRAPHQL_TYPES.has(svcDef["type"] ?? "")) {
        continue;
      }
      const graphqlPath = svcDef["graphql_path"] ?? "/graphql";
      let url: string;
      if (localServices.includes(svcName)) {
        const internalPort = svcDef["internal_port"] ?? 3000;
        url = `http://${svcName}:${internalPort}${graphqlPath}`;
      } else {
        const k8sPort = k8sPortForService(svcName, servicesConfig, portsConfig);
        if (!k8sPort) {
          continue;
        }
        url = `http://k8s-forwards:${k8sPort}${graphqlPath}`;
      }
      subgraphList.push({ name: svcName.replace(/-/g, "_"), url });
    }
    const rendered = template.render(
      jinjaContext({
        feature_name: feature,
        subgraphs: subgraphList,
      }),
    );
    fs.writeFileSync(outPath, rendered);
    success(`Generated supergraph config (template): ${outPath}`);
    return outPath;
  }
  warn(
    "Template 'supergraph-config.yml.njk' not found -- " +
    "falling back to built-in supergraph config generation",
  );

  // ---- Programmatic generation -----------------------------------------
  const subgraphs: Record<string, any> = {};

  for (const [svcName, svcDef] of Object.entries(servicesConfig)) {
    if (!isDict(svcDef)) {
      continue;
    }
    const svcType = svcDef["type"] ?? "";
    if (!_GRAPHQL_TYPES.has(svcType)) {
      continue;
    }

    const graphqlPath = svcDef["graphql_path"] ?? "/graphql";
    let url: string;
    if (localServices.includes(svcName)) {
      const internalPort = svcDef["internal_port"] ?? 3000;
      url = `http://${svcName}:${internalPort}${graphqlPath}`;
    } else {
      const k8sPort = k8sPortForService(svcName, servicesConfig, portsConfig);
      if (k8sPort) {
        url = `http://k8s-forwards:${k8sPort}${graphqlPath}`;
      } else {
        continue;
      }
    }

    const subgraphName = svcName.replace(/-/g, "_");
    subgraphs[subgraphName] = {
      routing_url: url,
      schema: { subgraph_url: url },
    };
  }

  const supergraph = { subgraphs };

  const header =
    "# AUTO-GENERATED FILE — DO NOT EDIT BY HAND.\n" +
    "# Source:    sandbox/config/services.yaml (type: graphql-subgraph,\n" +
    "#            k8s_forward_port)\n" +
    "#            + .sandbox/workspace.yml (feature local_services)\n" +
    "# Generator: src/lib/generate.ts :: generate_supergraph_config\n" +
    "# Regen:     sandbox up  (or `sandbox init-workspace`)\n" +
    "# To add a subgraph: set its `type: graphql-subgraph` in services.yaml and rerun.\n" +
    "# To change endpoint path, set `graphql_path: /<path>` on the service (default /graphql).\n" +
    `#\n# Feature: ${feature}\n` +
    "# Local subgraphs use the per-feature container network; remote\n" +
    "# subgraphs fall through to the shared k8s-forwards container.\n";
  fs.writeFileSync(
    outPath,
    header + YAML.stringify(supergraph, { indentSeq: false, singleQuote: true }),
  );

  success(`Generated supergraph config (built-in): ${outPath}`);
  return outPath;
}

// ---------------------------------------------------------------------------
// Caddyfile generation
// ---------------------------------------------------------------------------

/**
 * Generate `proxy/Caddyfile` from all active features.
 *
 * The entire generation is protected by the `caddyfile` advisory lock
 * so that concurrent `sandbox up` / `sandbox down` calls cannot
 * produce a Caddyfile that is missing another feature's routes.
 *
 * Parameters
 * ----------
 * allFeatures
 *     Mapping of feature name -> slot info.  If `null` (recommended),
 *     the current slots are re-read from disk inside the lock to ensure
 *     the latest state is used.
 * config
 *     Merged config dict.
 *
 * Returns the path to the generated Caddyfile.
 */
export function generateCaddyfile(
  allFeatures: Record<string, any> | null = null,
  config: Record<string, any> | null = null,
): string {
  const [servicesConfig, portsConfig] = resolveServicesAndPorts(config);
  const proxyDir = path.join(getInfraRoot(), "proxy");
  fs.mkdirSync(proxyDir, { recursive: true });
  const outPath = path.join(proxyDir, "Caddyfile");

  // Acquire lock BEFORE reading slots / writing the Caddyfile.  Re-read
  // slots inside the lock so we always see the latest committed state.
  return sandboxLock("caddyfile", () => {
    if (allFeatures === null || allFeatures === undefined) {
      allFeatures = getAllSlots();
    }

    // Write features.json for the feature selector UI
    const uiDir = path.join(proxyDir, "ui");
    fs.mkdirSync(uiDir, { recursive: true });
    const featuresJson = Object.entries(allFeatures)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([, featInfo]) => isDict(featInfo))
      .map(([name, featInfo]) => ({
        name,
        slot: featInfo["slot"] ?? null,
        services: featInfo["services"] ?? [],
      }));
    fs.writeFileSync(
      path.join(uiDir, "features.json"),
      JSON.stringify(featuresJson, null, 2) + "\n",
    );

    return generateCaddyfileLocked(
      allFeatures,
      servicesConfig,
      portsConfig,
      getSandboxRoot(),
      outPath,
    );
  });
}

/**
 * RE2 pattern matching exactly this feature's `X-Feature` cookie.
 *
 * Caddy has no cookie matcher, so this runs against the whole `Cookie` header.
 * The boundaries are load-bearing: a bare `X-Feature=web` substring would also
 * match `X-Feature=web-v2` and (via the name) `MY-X-Feature=web`, silently
 * routing one workspace's traffic to another's containers.
 */
function featureCookieRegexp(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:^|;\\s*)X-Feature=${escaped}(?:\\s*;|\\s*$)`;
}

/**
 * Build the Caddy host routers.
 *
 * A routed service may expose up to two site blocks, each terminating a
 * hostname and reverse-proxying to an `upstream` (`host:port`) after copying
 * any `X-Feature` cookie into an `X-Feature` header:
 *
 *  - Remote (K8s): `remote_hostname` -> `remote_upstream` (a cluster Service).
 *    Static — always emitted, independent of sandbox slots/features. The cookie
 *    is only copied to a header here; the upstream is fixed.
 *  - Local (docker feature): `hostname` -> one candidate upstream per feature
 *    that declares this service, at `host.docker.internal:<base_port(slot) +
 *    port_offset>`. The `X-Feature` cookie VALUE selects which one serves the
 *    request, so any number of workspaces share the hostname concurrently.
 *    A request with no cookie — or one naming a feature that doesn't run this
 *    service — falls through to `upstream` (the remote tunnel when there is one,
 *    else the first feature by name, so local-only services still resolve).
 *
 * Selecting on the cookie rather than picking a single winner is what makes
 * concurrent workstreams work. It also stops a torn-down-but-still-registered
 * feature from hijacking the hostname: a feature only ever claims its own cookie
 * value, and the no-cookie default prefers the always-live remote face.
 *
 * Returns `[{hostname, service, upstream, features?}, ...]`, where `features` is
 * `[{name, upstream, matcher, cookie_regexp}, ...]`, omitted entirely when no
 * feature declares the service so the template renders the static form.
 */
function buildHostRouters(
  allFeatures: Record<string, any>,
  servicesConfig: Record<string, any>,
): Record<string, any>[] {
  const routers: Record<string, any>[] = [];
  for (const [svcName, rc] of Object.entries(loadFeatureRouters(servicesConfig))) {
    // Remote (K8s) face: static upstream, independent of running features.
    if (rc.remoteHostname && rc.remoteUpstream) {
      routers.push({
        hostname: rc.remoteHostname,
        service: svcName,
        upstream: rc.remoteUpstream,
      });
    }
    // Local face: the running docker feature's container, else fall back to the
    // remote upstream so the local host always resolves to a live service.
    if (!rc.hostname) {
      continue;
    }
    const svcDef = servicesConfig[svcName] ?? {};
    const portOffset = isDict(svcDef) ? svcDef["port_offset"] ?? 0 : 0;
    const candidates = Object.entries(allFeatures)
      .filter(
        ([, fi]) =>
          isDict(fi) &&
          fi["slot"] !== null &&
          fi["slot"] !== undefined &&
          (fi["services"] ?? []).includes(svcName),
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, fi], idx) => ({
        name,
        upstream: `host.docker.internal:${getPortRange(fi["slot"])[0] + portOffset}`,
        // Index-prefixed so two feature names that differ only in characters the
        // sanitiser collapses (`a-b` vs `a_b`) can't produce one matcher name.
        matcher: `feat${idx}_${name.replace(/[^A-Za-z0-9_]/g, "_")}`,
        cookie_regexp: featureCookieRegexp(name),
      }));
    // Prefer the remote tunnel as the no-cookie default: it is always live, and
    // picking a local feature here is what used to let a dead workspace own the
    // hostname. Local-only services have no remote face, so they still fall back
    // to a feature rather than losing the site block entirely.
    const defaultUpstream = rc.remoteUpstream ?? candidates[0]?.upstream;
    // No feature and no fallback -> nothing to proxy to, skip.
    if (!defaultUpstream) {
      continue;
    }
    routers.push({
      hostname: rc.hostname,
      service: svcName,
      upstream: defaultUpstream,
      ...(candidates.length ? { features: candidates } : {}),
    });
  }
  return routers;
}

/** Render host-router site blocks (built-in fallback path). */
function hostRouterLines(routers: Record<string, any>[]): string[] {
  const lines: string[] = [];
  for (const r of routers) {
    lines.push(`# ${r["service"]} — Caddy terminates ${r["hostname"]} directly`);
    lines.push(`${r["hostname"]} {`);
    lines.push("    tls internal");
    lines.push("");
    lines.push("    # Sandbox feature selector UI (sets/clears the X-Feature cookie).");
    lines.push("    handle /__sandbox/features.json {");
    lines.push("        root * /sandbox/proxy/ui");
    lines.push("        rewrite * /features.json");
    lines.push("        file_server");
    lines.push("    }");
    lines.push("    handle /__sandbox* {");
    lines.push("        root * /sandbox/proxy/ui");
    lines.push("        rewrite * /index.html");
    lines.push("        file_server");
    lines.push("    }");
    lines.push("");
    const features = (r["features"] ?? []) as Record<string, any>[];
    if (features.length) {
      // One handle per feature, chosen by cookie value -> concurrent workspaces.
      for (const f of features) {
        lines.push(`    # X-Feature=${f["name"]} -> that workspace's containers.`);
        lines.push(`    @${f["matcher"]} header_regexp Cookie ${f["cookie_regexp"]}`);
        lines.push(`    handle @${f["matcher"]} {`);
        lines.push(`        reverse_proxy ${f["upstream"]} {`);
        lines.push(`            header_up X-Feature ${f["name"]}`);
        lines.push("        }");
        lines.push("    }");
      }
      lines.push("    # No cookie, or one naming a feature not serving this service.");
    } else {
      lines.push("    # X-Feature cookie -> X-Feature header (when present), then proxy.");
      lines.push("    @xf header_regexp xf Cookie X-Feature=([^;]+)");
      lines.push("    handle @xf {");
      lines.push(`        reverse_proxy ${r["upstream"]} {`);
      lines.push("            header_up X-Feature {re.xf.1}");
      lines.push("        }");
      lines.push("    }");
    }
    // `/*` rather than a bare `handle`: the more specific `/__sandbox*` sibling
    // still wins, and the structural lint's bare-vs-scoped route-drop guard stays
    // meaningful instead of firing on every generated file.
    lines.push("    handle /* {");
    lines.push(`        reverse_proxy ${r["upstream"]}`);
    lines.push("    }");
    lines.push("}");
    lines.push("");
  }
  return lines;
}

/** Inner Caddyfile generator — called while holding the caddyfile lock. */
function generateCaddyfileLocked(
  allFeatures: Record<string, any>,
  servicesConfig: Record<string, any>,
  portsConfig: Record<string, any>,
  _root: string,
  outPath: string,
): string {
  const hostRouters = buildHostRouters(allFeatures, servicesConfig);

  // Try template
  const jinjaEnv = getNunjucksEnv();
  const template = getTemplateOrNull(jinjaEnv, "Caddyfile.njk");
  if (template) {
    const rendered = template.render(jinjaContext({ host_routers: hostRouters }));
    fs.writeFileSync(outPath, rendered);
    success(`Generated Caddyfile (template): ${outPath}`);
    return outPath;
  }
  warn("Template 'Caddyfile.njk' not found -- " + "falling back to built-in Caddyfile generation");

  // ---- Programmatic generation -----------------------------------------
  const lines: string[] = [
    "# Auto-generated Caddyfile -- do not edit manually",
    "# Regenerate with: sandbox proxy-reload",
    "",
    "{",
    "    admin localhost:2019",
    "}",
    "",
    ...hostRouterLines(hostRouters),
  ];

  fs.writeFileSync(outPath, lines.join("\n"));
  success(`Generated Caddyfile (built-in): ${outPath}`);
  return outPath;
}

// ---------------------------------------------------------------------------
// Workspace compose orchestration
// ---------------------------------------------------------------------------

/**
 * Allocate a slot and write docker-compose.yml to the workspace root.
 *
 * Returns the allocated slot number, or null if setup could not complete.
 *
 * Parameters
 * ----------
 * allocateSlotFn
 *     Unused for now (accepted and ignored). Exists only so a future caller
 *     could inject a stub slot-allocation function; kept for TEST-01
 *     coverage in the sibling plan.
 */
export function generateWorkspaceCompose(
  feature: string,
  servicesStr: string,
  workspaceRoot: string,
  _allocateSlotFn?: unknown,
): number | null {
  info("Generating docker-compose.yml...");
  const servicesConfig = loadServices();
  const portsConfig = loadPorts();
  const config = { services: servicesConfig, ports: portsConfig };

  // Build alias map: path basename → canonical service name.
  // Handles a SERVICES entry naming a container/alias that maps to a
  // differently-keyed registry entry.
  const pathAliases: Record<string, string> = {};
  for (const [svcName, svcDef] of Object.entries(servicesConfig)) {
    if (!isDict(svcDef)) {
      continue;
    }
    const stripped = ((svcDef["path"] ?? "") as string).replace(/\/+$/, "");
    const basename = stripped.includes("/")
      ? stripped.slice(stripped.lastIndexOf("/") + 1)
      : stripped;
    if (basename !== svcName) {
      pathAliases[basename] = svcName;
    }
  }

  const resolve = (name: string): string | null => {
    if (name in servicesConfig) {
      return name;
    }
    const resolved = pathAliases[name];
    if (resolved) {
      info(`  Resolved service alias: ${name} → ${resolved}`);
      return resolved;
    }
    return resolved ?? null;
  };

  const requested = servicesStr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  const resolvedMap = new Map<string, string | null>();
  for (const s of requested) {
    resolvedMap.set(s, resolve(s));
  }
  const localServices = [...resolvedMap.values()].filter((r): r is string => r !== null);
  const unknown = [...resolvedMap.entries()].filter(([, r]) => r === null).map(([s]) => s);
  if (unknown.length > 0) {
    warn(`Unknown services (skipped): ${unknown.join(", ")}`);
  }

  let slot: number;
  try {
    slot = allocateSlot(feature, localServices);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    warn(`Could not allocate slot: ${msg}`);
    // The lock has no distinct timeout error type — it signals one in the message.
    if (msg.startsWith("Timed out")) {
      warn("Retry, or remove the stale lock file if no sandbox process is running.");
    } else {
      warn("Run 'sandbox down <feature>' to free a slot, then re-run init-workspace.");
    }
    return null;
  }

  generateFeatureCompose(
    feature,
    slot,
    localServices,
    config,
    workspaceRoot,
    "sandbox init-workspace",
  );
  generateFeatureEnv(feature, slot, localServices, config, workspaceRoot);
  generateSupergraphConfig(feature, slot, localServices, config, workspaceRoot);

  const [portStart, portEnd] = getPortRange(slot);
  success(`Compose ready (slot ${slot}, ports ${portStart}-${portEnd})`);

  const contextMd = buildSandboxContextMd(
    feature,
    slot,
    portStart,
    portEnd,
    localServices,
    servicesConfig,
  );
  const sandboxDir = path.join(workspaceRoot, ".sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, "sandbox-context.md"), contextMd);
  success("Wrote .sandbox/sandbox-context.md");

  return slot;
}
