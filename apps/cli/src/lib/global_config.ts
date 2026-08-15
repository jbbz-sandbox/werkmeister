/**
 * Machine-global sandbox configuration.
 *
 * `~/.sandbox/config.yaml` is the single source of truth for machine-global
 * settings (repo/workspace roots, optional overrides, and the optional Jira REST
 * credentials). This module owns reading and writing it, and projecting it onto
 * the backward-compat surfaces:
 *
 * - `~/.sandbox/env.sh`  — `export SANDBOX_*=…` lines, sourced by the shell and
 *   by the `sandbox` wrapper so external processes and the node MCP app still see
 *   the vars.
 * - `~/.zshenv`          — one managed block that sources env.sh (replacing the
 *   old hardcoded exports).
 * - `claude_desktop_config.json` — the sandbox MCP server's redundant `env`
 *   block is removed (the wrapper self-loads env.sh).
 *
 * The CLI reads *values* only from the YAML (never from `SANDBOX_*` env at
 * runtime). The one env var honoured here is `SANDBOX_CONFIG_FILE` — it names
 * *which* YAML to read (default `~/.sandbox/config.yaml`), a location, not a
 * value, so "single source = the YAML" stays literally true and the loader is
 * testable against a temp file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as YAML from "yaml";

import { expandUser, getSandboxRoot, warn } from "./config.js";
import type { PromptSpec } from "./wizard.js";

export type { PromptSpec };

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const _ABS_PATH = "^/\\S*$"; // absolute path (leading slash, no whitespace)

/** Path to the global config YAML (`SANDBOX_CONFIG_FILE` or the default). */
export function configPath(): string {
  const override = process.env.SANDBOX_CONFIG_FILE;
  if (override) {
    return expandUser(override);
  }
  return path.join(os.homedir(), ".sandbox", "config.yaml");
}

/**
 * The `~/.sandbox` directory — every machine-global file lives here.
 *
 * Derived from `configPath()` rather than hardcoded so `SANDBOX_CONFIG_FILE`
 * relocates the whole set together (tests point it at a temp dir).
 */
export function sandboxHome(): string {
  return path.dirname(configPath());
}

/** Path to the generated shell export file (sibling of the config). */
export function envShPath(): string {
  return path.join(sandboxHome(), "env.sh");
}

// ---------------------------------------------------------------------------
// Registry config locations
// ---------------------------------------------------------------------------
// The service registry, port map and pricing table used to be committed under
// `<repo>/infra/config/`. They describe THIS MACHINE's services, not the
// checkout, so they now live beside config.yaml in ~/.sandbox and are seeded by
// `sandbox setup`. Each resolves as: `overrides.<key>` in config.yaml →
// ~/.sandbox/<file>. The overrides are also projected to SANDBOX_*_YAML env vars
// (see _ENV_MAP) for the out-of-process consumers in packages/sandbox-driver.

/** Resolve one registry file: `overrides.<overrideKey>` → `~/.sandbox/<basename>`. */
function registryPath(overrideKey: string, basename: string): string {
  const override = (load()["overrides"] ?? {})[overrideKey];
  if (override) {
    return path.resolve(expandUser(String(override)));
  }
  return path.join(sandboxHome(), basename);
}

/** Path to the service registry (`overrides.services_yaml` → ~/.sandbox/services.yaml). */
export function servicesYamlPath(): string {
  return registryPath("services_yaml", "services.yaml");
}

/** Path to the port allocation map (`overrides.ports_yaml` → ~/.sandbox/ports.yaml). */
export function portsYamlPath(): string {
  return registryPath("ports_yaml", "ports.yaml");
}

/** Path to the model pricing table (`overrides.model_pricing_yaml` → ~/.sandbox/model-pricing.yaml). */
export function modelPricingYamlPath(): string {
  return registryPath("model_pricing_yaml", "model-pricing.yaml");
}

/**
 * Root of the code-standards source tree (`overrides.standards_dir` →
 * `<sandbox root>/docs/standards`).
 *
 * The standards are one organization's *content*; the CLI is a reusable tool.
 * This is the seam between them — point it at any directory laid out the way
 * `loadStandardsModules` expects and `sandbox standards check` gates it there
 * too. Unlike the registry files above it has no `~/.sandbox` default: the
 * bundled tree ships with the checkout, so an unconfigured install keeps
 * working.
 */
export function standardsDirPath(): string {
  const override = (load()["overrides"] ?? {})["standards_dir"];
  if (override) {
    return path.resolve(expandUser(String(override)));
  }
  return path.join(getSandboxRoot(), "docs", "standards");
}

/**
 * Describe why the standards tree is unusable, or "" when it is fine.
 *
 * The fallback above is a convention (a tree bundled beside the CLI), not a
 * promise — this repo no longer ships one, so an unconfigured install resolves
 * a directory that does not exist. The loader treats that as "no modules" and
 * carries on, which is right for a hook that must never block a launch and
 * wrong for anything a human is watching: a workspace inits with an empty
 * routing table and no standards skills, and nothing says so. Every
 * human-facing entry point reports this; the fail-open paths still don't.
 */
export function standardsDirProblem(): string {
  const dir = standardsDirPath();
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return "";
  }
  const configured = (load()["overrides"] ?? {})["standards_dir"];
  return configured
    ? `standards tree not found: ${dir} (overrides.standards_dir in ${configPath()})`
    : `no standards tree: overrides.standards_dir is unset in ${configPath()} and ` +
        `the default ${dir} does not exist`;
}

/**
 * Path to the hand-edited secrets file (sibling of the config).
 *
 * Lives in `~/.sandbox` (outside the repo) so real credentials never sit in
 * the checkout. Docker Compose reads it directly as an `env_file`; the CLI
 * reads it via `lib/secrets`.
 */
export function secretsPath(): string {
  return path.join(sandboxHome(), "secrets.env");
}

export function zshenvPath(): string {
  return path.join(os.homedir(), ".zshenv");
}

export function desktopConfigPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
}

// ---------------------------------------------------------------------------
// YAML → env var projection map
// ---------------------------------------------------------------------------
// (yaml section, key, env var). Emitted to env.sh only when the value is set.
const _ENV_MAP: readonly [string, string, string][] = [
  ["paths", "sandbox_root", "SANDBOX_ROOT"],
  ["paths", "repos_root", "SANDBOX_REPOS_ROOT"],
  ["paths", "workspaces_root", "SANDBOX_WORKSPACES_ROOT"],
  ["overrides", "mcp_port", "SANDBOX_MCP_PORT"],
  ["overrides", "node", "SANDBOX_NODE"],
  ["overrides", "services_yaml", "SANDBOX_SERVICES_YAML"],
  ["overrides", "ports_yaml", "SANDBOX_PORTS_YAML"],
  ["overrides", "model_pricing_yaml", "SANDBOX_MODEL_PRICING_YAML"],
  ["overrides", "cache_file", "SANDBOX_CACHE_FILE"],
  // Consumed by infra/compose/shared-infra.yml, which bind-mounts the cert dir
  // into the Caddy container. Exported so `docker compose` sees it.
  ["ingress", "certs_dir", "SANDBOX_CERTS_DIR"],
];

// Managed-block markers for ~/.zshenv (idempotent replace).
const _ZSH_BEGIN = "# >>> sandbox config >>>";
const _ZSH_END = "# <<< sandbox config <<<";

// Old hardcoded exports we migrate away from (stripped from ~/.zshenv on write).
const _LEGACY_EXPORT_VARS = ["SANDBOX_ROOT", "SANDBOX_REPOS_ROOT", "SANDBOX_WORKSPACES_ROOT"];

// ---------------------------------------------------------------------------
// Prompts (repos_root, workspaces_root) — reused by the config command wizard
// ---------------------------------------------------------------------------
export const _CONFIG_PROMPTS: readonly PromptSpec[] = [
  {
    key: "repos_root",
    label: "Repos root (absolute path)",
    help: "Directory holding the canonical source-repo clones " +
          "(exported as SANDBOX_REPOS_ROOT).",
    acceptEmpty: false,
    pattern: _ABS_PATH,
    placeholder: "/Users/you/workspace",
  },
  {
    key: "workspaces_root",
    label: "Workspaces root (absolute path)",
    help: "Directory holding per-feature worktree workspaces " +
          "(exported as SANDBOX_WORKSPACES_ROOT).",
    acceptEmpty: false,
    pattern: _ABS_PATH,
    placeholder: "/Users/you/workspace/features",
  },
];

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load the config YAML; missing/invalid file → `{}` (callers apply defaults). */
export function load(): Record<string, any> {
  const p = configPath();
  if (!fs.existsSync(p)) {
    return {};
  }
  let data: unknown;
  try {
    data = YAML.parse(fs.readFileSync(p, "utf8"));
  } catch (exc) {
    warn(`Could not parse ${p}: ${exc}`);
    return {};
  }
  return isDict(data) ? data : {};
}

/** Return the `paths:` sub-dict (or `{}`). Used by `lib/config`. */
export function loadPaths(): Record<string, string> {
  const paths = load()["paths"];
  return isDict(paths) ? paths : {};
}

/** Jira REST credentials as stored in the YAML (`base_url`, `email`, `api_token`). */
export interface JiraSettings {
  base_url?: string;
  email?: string;
  api_token?: string;
  /**
   * Site id for the Atlassian MCP / api.atlassian.com gateway, which addresses
   * sites by id rather than hostname. Not used by the Basic-auth REST path in
   * `sandbox-driver/jira-rest`, so it stays optional.
   */
  cloud_id?: string;
}

/**
 * Return the `jira:` sub-dict (or `{}`) — the optional Jira REST fast path.
 *
 * Deliberately absent from `_ENV_MAP`: env.sh is sourced from ~/.zshenv, so
 * projecting `api_token` there would export a live credential into every shell
 * and every child process. Consumers read the YAML instead.
 */
export function loadJira(): JiraSettings {
  const jira = load()["jira"];
  return isDict(jira) ? jira : {};
}

// ---------------------------------------------------------------------------
// Ingress (public hostnames Caddy terminates)
// ---------------------------------------------------------------------------

/** Base domains and cert location for the locally-terminated ingress. */
export interface IngressSettings {
  /** Base domain for local docker features (`<service>.<local_domain>`). */
  local_domain: string;
  /** Base domain for remote K8s deployments (`<service>.<remote_domain>`). */
  remote_domain: string;
  /** Directory holding localhost.crt/localhost.key (bind-mounted into Caddy). */
  certs_dir: string;
}

export const INGRESS_DEFAULTS: IngressSettings = {
  local_domain: "local.sandbox.com",
  remote_domain: "remote.sandbox.com",
  certs_dir: path.join(os.homedir(), ".docker", "certs"),
};

/**
 * Return the `ingress:` sub-dict with defaults filled in.
 *
 * These base domains are the single source of truth for every public hostname
 * in the system: `feature_routing` derives per-service hostnames from them, the
 * Caddyfile generator terminates those hostnames, and `bin/generate-certs.sh`
 * puts the same list in the certificate SANs and /etc/hosts. A service may
 * still pin a non-conforming host via `feature_router.hostname`.
 */
export function loadIngress(cfg?: Record<string, any>): IngressSettings {
  const raw = (cfg ?? load())["ingress"];
  const ingress = isDict(raw) ? raw : {};
  const pick = (key: keyof IngressSettings): string => {
    const value = ingress[key];
    return typeof value === "string" && value.trim() ? value.trim() : INGRESS_DEFAULTS[key];
  };
  return {
    local_domain: pick("local_domain"),
    remote_domain: pick("remote_domain"),
    certs_dir: expandUser(pick("certs_dir")),
  };
}

// ---------------------------------------------------------------------------
// GitHub owners (`overrides.workspace_repo`, `overrides.github_org`)
// ---------------------------------------------------------------------------

/**
 * The `owner/repo` whose worktrees become each feature-workspace root.
 *
 * Lives in `overrides:` rather than in a section of its own so `sandbox config`
 * — which rebuilds the YAML and preserves overrides verbatim — cannot drop it.
 * Empty means unconfigured: `sandbox setup` derives the default from the
 * authenticated GitHub user, and warns when it can't.
 */
export function loadWorkspaceRepo(cfg?: Record<string, any>): string {
  const value = ((cfg ?? load())["overrides"] ?? {})["workspace_repo"];
  return typeof value === "string" ? value.trim() : "";
}

/** `owner/repo` — GitHub's own slug shape, no scheme and no `.git` suffix. */
const _REPO_SLUG = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$";

/** Workspace-repo prompt — driven by `sandbox setup`. */
export const _WORKSPACE_REPO_PROMPT: PromptSpec = {
  key: "workspace_repo",
  label: "Workspace config repo (owner/repo)",
  help: "GitHub repo cloned under the repos root and worktree'd as the root of " +
        "every feature workspace, so .sandbox/ configs and notes get history. " +
        "Defaults to your own; point it at a shared <org>/sandbox-workspace to " +
        "share workspace configs with your team.",
  acceptEmpty: false,
  pattern: _REPO_SLUG,
  placeholder: "your-org/sandbox-workspace",
};

/**
 * The GitHub owner the service repos live under — nothing here is Sandbox's own.
 *
 * Standards docs name their canonical examples as `<repo>:<path>`; this is what
 * turns those into links. Defaults to whoever owns the workspace repo, which is
 * the same org for a team that configured one. Empty means unknown, and callers
 * must degrade (name the file, link nothing) rather than guess an owner.
 */
export function loadGithubOrg(cfg?: Record<string, any>): string {
  const c = cfg ?? load();
  const explicit = (c["overrides"] ?? {})["github_org"];
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return loadWorkspaceRepo(c).split("/")[0] ?? "";
}

/** GitHub org/user prompt — driven by `sandbox setup`. */
export const _GITHUB_ORG_PROMPT: PromptSpec = {
  key: "github_org",
  label: "GitHub org for service repos",
  help: "Owner of the repos in your services registry. Used to link the " +
        "canonical examples that standards docs cite (github.com/<org>/<repo>).",
  acceptEmpty: false,
  pattern: "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$",
  placeholder: "your-org",
};

// A DNS domain: dot-separated labels, no scheme, no path, no trailing dot.
const _DOMAIN = "[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$";

/** Ingress prompts — driven by `sandbox setup`, alongside `_CONFIG_PROMPTS`. */
export const _INGRESS_PROMPTS: readonly PromptSpec[] = [
  {
    key: "local_domain",
    label: "Local ingress domain",
    help: "Base domain for docker features — each routed service is served at " +
          "<service>.<domain> and Caddy terminates TLS for it.",
    acceptEmpty: false,
    pattern: _DOMAIN,
    placeholder: INGRESS_DEFAULTS.local_domain,
  },
  {
    key: "remote_domain",
    label: "Remote (K8s) ingress domain",
    help: "Base domain for services routed to the dev cluster instead of a " +
          "local container — served at <service>.<domain>.",
    acceptEmpty: false,
    pattern: _DOMAIN,
    placeholder: INGRESS_DEFAULTS.remote_domain,
  },
  {
    key: "certs_dir",
    label: "Certificate directory (absolute path)",
    help: "Where bin/generate-certs.sh writes localhost.crt/.key; bind-mounted " +
          "into the Caddy container (exported as SANDBOX_CERTS_DIR).",
    acceptEmpty: false,
    pattern: _ABS_PATH,
    placeholder: INGRESS_DEFAULTS.certs_dir,
  },
];

const _HEADER =
  "# Global sandbox configuration — single source of truth.\n" +
  "# Managed by `sandbox config`; safe to hand-edit, then run " +
  "`sandbox config --check`.\n";

/** Write the config YAML (creating ~/.sandbox/ as needed). */
export function save(cfg: Record<string, any>): string {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, _HEADER + YAML.stringify(cfg));
  // `jira.api_token` is a live Atlassian credential — owner-only, like the
  // secrets file. chmod separately: writeFileSync's mode applies to a file it
  // creates, not to one that already exists at the default 644.
  fs.chmodSync(p, 0o600);
  return p;
}

// ---------------------------------------------------------------------------
// env.sh generation
// ---------------------------------------------------------------------------

/** POSIX shell quoting. */
function shQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** Render the `export SANDBOX_*=…` shell text from the config. */
export function renderEnvSh(cfg: Record<string, any>): string {
  const lines = [
    "# Generated by `sandbox config` from ~/.sandbox/config.yaml — DO NOT EDIT.",
    "# Sourced by ~/.zshenv and the `sandbox` wrapper for backward compatibility.",
  ];
  for (const [section, key, envVar] of _ENV_MAP) {
    const value = (cfg[section] ?? {})[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    // Every mapped value is a path or a scalar; expand a leading `~` here so
    // consumers that don't do shell tilde expansion (docker compose reading
    // SANDBOX_CERTS_DIR, node reading SANDBOX_SERVICES_YAML) get a real path.
    const text = String(value);
    lines.push(`export ${envVar}=${shQuote(text.startsWith("~") ? expandUser(text) : text)}`);
  }
  return lines.join("\n") + "\n";
}

export function writeEnvSh(cfg: Record<string, any>): string {
  const p = envShPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderEnvSh(cfg));
  return p;
}

// ---------------------------------------------------------------------------
// ~/.zshenv managed block
// ---------------------------------------------------------------------------

function managedBlock(): string {
  return (
    `${_ZSH_BEGIN}\n` +
    "# Managed by `sandbox config` — do not edit; regenerated on `sandbox config`.\n" +
    '[ -f "$HOME/.sandbox/env.sh" ] && . "$HOME/.sandbox/env.sh"\n' +
    `${_ZSH_END}\n`
  );
}

/** Remove any prior managed block and the legacy hardcoded SANDBOX_* exports. */
function stripManagedAndLegacy(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.trim() === _ZSH_BEGIN) {
      inBlock = true;
      continue;
    }
    if (line.trim() === _ZSH_END) {
      inBlock = false;
      continue;
    }
    if (inBlock) {
      continue;
    }
    const stripped = line.trim();
    if (
      stripped.startsWith("export ") &&
      _LEGACY_EXPORT_VARS.some((v) => stripped.slice("export ".length).startsWith(`${v}=`))
    ) {
      continue; // drop legacy hardcoded export — env.sh owns it now
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Idempotently install the managed source-block in ~/.zshenv.
 *
 * Removes any prior managed block and legacy hardcoded exports, then appends a
 * fresh block. Returns true if the file content changed.
 */
export function ensureZshenvSources(p?: string): boolean {
  const target = p ?? zshenvPath();
  const original = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const body = stripManagedAndLegacy(original).replace(/\n+$/, "");
  const updated = (body ? body + "\n\n" : "") + managedBlock();
  if (updated === original) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, updated);
  return true;
}

// ---------------------------------------------------------------------------
// claude_desktop_config.json
// ---------------------------------------------------------------------------

/** A sandbox MCP server: command basename `sandbox` invoked with `mcp`. */
function isSandboxServer(body: Record<string, any>): boolean {
  const command = String(body["command"] ?? "");
  const args: unknown[] = body["args"] ?? [];
  return path.basename(command) === "sandbox" && args[0] === "mcp";
}

/**
 * Drop the redundant `env` block from the sandbox MCP server entry.
 *
 * Idempotent; no-op when the file, the server, or the block is absent. Returns
 * true if a change was written.
 */
export function patchDesktopConfig(p?: string): boolean {
  const target = p ?? desktopConfigPath();
  if (!fs.existsSync(target)) {
    return false;
  }
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (exc) {
    warn(`Could not parse ${target}: ${exc}`);
    return false;
  }

  let changed = false;
  for (const body of Object.values(data["mcpServers"] ?? {})) {
    if (isDict(body) && isSandboxServer(body) && "env" in body) {
      delete body["env"];
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(target, JSON.stringify(data, null, 2) + "\n");
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------

/** Return a list of drift/setup problems (empty = healthy). */
export function check(cfg: Record<string, any>): string[] {
  const problems: string[] = [];

  if (!fs.existsSync(configPath())) {
    problems.push(`config file missing: ${configPath()} — run \`sandbox config\``);
    return problems;
  }

  const paths = cfg["paths"] ?? {};
  for (const key of ["repos_root", "workspaces_root"]) {
    const value = paths[key];
    if (!value) {
      problems.push(`paths.${key} is not set`);
    } else {
      const expanded = expandUser(String(value));
      if (!(fs.existsSync(expanded) && fs.statSync(expanded).isDirectory())) {
        problems.push(`paths.${key} does not exist: ${value}`);
      }
    }
  }

  const standardsProblem = standardsDirProblem();
  if (standardsProblem) {
    problems.push(standardsProblem);
  }

  const envPath = envShPath();
  if (!fs.existsSync(envPath)) {
    problems.push(`${envPath} missing — run \`sandbox config\``);
  } else if (fs.readFileSync(envPath, "utf8") !== renderEnvSh(cfg)) {
    problems.push(`${envPath} is stale — run \`sandbox config\` to regenerate`);
  }

  const zpath = zshenvPath();
  if (!fs.existsSync(zpath) || !fs.readFileSync(zpath, "utf8").includes(_ZSH_BEGIN)) {
    problems.push(`${zpath} does not source env.sh — run \`sandbox config\``);
  }

  const dpath = desktopConfigPath();
  if (fs.existsSync(dpath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dpath, "utf8"));
      for (const body of Object.values(data["mcpServers"] ?? {})) {
        if (isDict(body) && isSandboxServer(body) && "env" in body) {
          problems.push(
            `${dpath}: sandbox server still has a stale \`env\` block — ` +
            "run `sandbox config`",
          );
        }
      }
    } catch {
      // malformed Desktop config isn't ours to diagnose here
    }
  }

  return problems;
}
