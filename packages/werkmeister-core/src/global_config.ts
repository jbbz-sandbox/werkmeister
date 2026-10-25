/**
 * Machine-global sandbox configuration.
 *
 * `~/.werkmeister/config.yaml` is the single source of truth for machine-global
 * settings (repo/workspace roots, optional overrides, and the optional Jira REST
 * credentials). This module owns reading and writing it, and projecting it onto
 * the backward-compat surfaces:
 *
 * - `~/.werkmeister/env.sh`  — `export SANDBOX_*=…` lines, sourced by the shell and
 *   by the `sandbox` wrapper so external processes and the node MCP app still see
 *   the vars.
 * - `~/.zshenv`          — one managed block that sources env.sh (replacing the
 *   old hardcoded exports).
 * - `claude_desktop_config.json` — the sandbox MCP server's redundant `env`
 *   block is removed (the wrapper self-loads env.sh).
 *
 * The CLI reads *values* only from the YAML (never from `SANDBOX_*` env at
 * runtime). The one env var honoured here is `SANDBOX_CONFIG_FILE` — it names
 * *which* YAML to read (default `~/.werkmeister/config.yaml`), a location, not a
 * value, so "single source = the YAML" stays literally true and the loader is
 * testable against a temp file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as YAML from "yaml";

import {
  configPath,
  dotDir,
  envVar,
  expandUser,
  type GlobalConfig,
  loadConfig,
  modelPricingYamlPath,
  portsYamlPath,
  sandboxHome,
  sandboxRoot,
  servicesLocalYamlPath,
  servicesYamlPath,
} from "./config.js";
import { warn } from "./reporter.js";

/**
 * One input a command collects. Pure data: it declares what to ask and how to
 * validate, never how to render — the CLI's `wizard.ts` drives these as
 * terminal prompts, the dashboard projects the same specs into a web form.
 * It lives here rather than in the wizard because the specs do, and the wizard
 * is the one module that cannot leave the CLI.
 */
export interface PromptSpec {
  key: string; // config-field name (feature, repos_root, …)
  label: string; // prompt text shown to the user
  help: string; // one-line "why it matters"
  acceptEmpty?: boolean; // may the user submit nothing? (default true)
  multi?: boolean; // comma-separated multi-value (services)
  multiline?: boolean; // free-form prose (form: textarea widget)
  boolean?: boolean; // on/off (form: checkbox; wizard: yes/no)
  refinable?: boolean; // form: offer a "Refine with Claude" button
  refineInstruction?: string | null; // how Claude should rewrite the field
  recommended?: boolean; // strongly-recommended input (feature)
  pattern?: string | null; // anchored regex a non-empty value must match
  placeholder?: string | null; // example value (UI hint; not a default)
  default?: string | null; // a default that doesn't depend on the workspace (shown when no defaultFn runs)
  defaultFn?: ((workspace: string) => string) | null; // derive a default from the workspace
  choicesFn?: (() => string[]) | null; // enumerate valid values (services)
  choiceGroupsFn?: (() => Record<string, string>) | null; // choice → heading it's listed under (service → repo)
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const _ABS_PATH = "^/\\S*$"; // absolute path (leading slash, no whitespace)

// `configPath` / `sandboxHome` and the registry-path family are re-exported from
// `werkmeister-core/config` rather than defined here: the dashboard and MCP servers
// resolve the same files out-of-process, and two implementations had already
// drifted apart on precedence. See that module's header.
export {
  configPath,
  modelPricingYamlPath,
  portsYamlPath,
  sandboxHome,
  servicesLocalYamlPath,
  servicesYamlPath,
};

/** Path to the generated shell export file (sibling of the config). */
export function envShPath(): string {
  return path.join(sandboxHome(), "env.sh");
}

// ---------------------------------------------------------------------------
// Registry config locations
// ---------------------------------------------------------------------------
// The service registry, port map and pricing table describe THIS MACHINE's
// services, not the checkout, so they live beside config.yaml in ~/.werkmeister and
// are seeded by `sandbox setup`. Resolution moved to `werkmeister-core/config`
// (re-exported above) — out-of-process consumers now read the same YAML this
// does, instead of relying on the SANDBOX_*_YAML exports having been sourced.
// Those exports (see _ENV_MAP) remain as the fallback for a shell.

/**
 * Root of the code-standards source tree (`overrides.standards_dir` →
 * `<sandbox root>/docs/standards`).
 *
 * The standards are one organization's *content*; the CLI is a reusable tool.
 * This is the seam between them — point it at any directory laid out the way
 * `loadStandardsModules` expects and `sandbox standards check` gates it there
 * too. Unlike the registry files above it has no `~/.werkmeister` default: the
 * bundled tree ships with the checkout, so an unconfigured install keeps
 * working.
 */
export function standardsDirPath(): string {
  const override = load()["overrides"]?.["standards_dir"];
  if (override) {
    return path.resolve(expandUser(String(override)));
  }
  return path.join(sandboxRoot(), "docs", "standards");
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
  const configured = load()["overrides"]?.["standards_dir"];
  return configured
    ? `standards tree not found: ${dir} (overrides.standards_dir in ${configPath()})`
    : `no standards tree: overrides.standards_dir is unset in ${configPath()} and ` +
        `the default ${dir} does not exist`;
}

/**
 * Path to the hand-edited secrets file (sibling of the config).
 *
 * Lives in `~/.werkmeister` (outside the repo) so real credentials never sit in
 * the checkout. Docker Compose reads it directly as an `env_file`; the CLI
 * reads it via `lib/secrets`.
 */
export function secretsPath(): string {
  return path.join(sandboxHome(), "secrets.env");
}

export function zshenvPath(): string {
  return path.join(os.homedir(), ".zshenv");
}

/**
 * The interactive rc file, where tab completion is installed.
 *
 * Not `.zshenv`: that one is sourced by every zsh, scripts included, and
 * `compinit`/`bashcompinit` are interactive-shell machinery it has no business
 * paying for.
 */
export function zshrcPath(): string {
  return path.join(os.homedir(), ".zshrc");
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
// Consumed by shells and by compose; `werkmeister-core/config` reads the YAML.
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

// Managed-block markers for ~/.zshrc (tab completion; idempotent replace).
const _COMPLETION_BEGIN = "# >>> sandbox completion >>>";
const _COMPLETION_END = "# <<< sandbox completion <<<";

// Old hardcoded exports we migrate away from (stripped from ~/.zshenv on write).
const _LEGACY_EXPORT_VARS = ["SANDBOX_ROOT", "SANDBOX_REPOS_ROOT", "SANDBOX_WORKSPACES_ROOT"];

// ---------------------------------------------------------------------------
// Prompts (repos_root, workspaces_root) — reused by the config command wizard
// ---------------------------------------------------------------------------
export const _CONFIG_PROMPTS: readonly PromptSpec[] = [
  {
    key: "repos_root",
    label: "Repos root (absolute path)",
    help:
      "Directory holding the canonical source-repo clones " + "(exported as SANDBOX_REPOS_ROOT).",
    acceptEmpty: false,
    pattern: _ABS_PATH,
    placeholder: "/Users/you/workspace",
  },
  {
    key: "workspaces_root",
    label: "Workspaces root (absolute path)",
    help:
      "Directory holding per-feature worktree workspaces " +
      "(exported as SANDBOX_WORKSPACES_ROOT).",
    acceptEmpty: false,
    pattern: _ABS_PATH,
    placeholder: "/Users/you/workspace/features",
  },
];

// Migration source (currently-exported env) for each path prompt, so a machine
// configured before the YAML existed migrates by pressing Enter through.
const _PATH_ENV: Record<string, string> = {
  repos_root: "REPOS_ROOT",
  workspaces_root: "WORKSPACES_ROOT",
};

/**
 * Built-in fallback for one `paths:` key — what an unconfigured machine gets.
 *
 * `reposRoot` overrides the home-relative base, so the workspaces root can be
 * derived from a repos root the config or the user has already named.
 */
export function builtinPathDefault(key: string, reposRoot = ""): string {
  const base = reposRoot || path.join(os.homedir(), "workspace");
  return key === "workspaces_root" ? path.join(base, "features") : base;
}

/**
 * The default offered for one `paths:` prompt: stored YAML → exported env →
 * built-in.
 *
 * `resolved` carries the answers already given in *this* run, so on a machine
 * with nothing stored the workspaces root follows the repos root the user just
 * typed. Offering `~/workspace/features` one line after they said their repos
 * live in `~/code` is the wizard talking them into a layout they didn't pick.
 */
export function pathDefault(
  key: string,
  cfg?: GlobalConfig,
  resolved: Record<string, string> = {},
): string {
  const paths = (cfg ?? load())["paths"] ?? {};
  const stored = paths[key] || envVar(_PATH_ENV[key]);
  if (stored) {
    return String(stored);
  }
  const reposRoot =
    resolved["repos_root"] || String(paths["repos_root"] || envVar(_PATH_ENV["repos_root"]) || "");
  return builtinPathDefault(key, reposRoot);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load the config YAML; missing/invalid file → `{}` (callers apply defaults). */
export function load(): GlobalConfig {
  try {
    return loadConfig();
  } catch (exc) {
    warn(`Could not parse ${configPath()}: ${exc}`);
    return {};
  }
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
   * `werkmeister-core/jira-rest`, so it stays optional.
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
  // SW-93: sandbox.com belongs to someone else. A machine whose config.yaml sets
  // these (every `setup` run writes them) keeps its domains.
  local_domain: "local.werkmeister.io",
  remote_domain: "remote.werkmeister.io",
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
export function loadIngress(cfg?: GlobalConfig): IngressSettings {
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
export function loadWorkspaceRepo(cfg?: GlobalConfig): string {
  const value = (cfg ?? load())["overrides"]?.["workspace_repo"];
  return typeof value === "string" ? value.trim() : "";
}

/** `owner/repo` — GitHub's own slug shape, no scheme and no `.git` suffix. */
const _REPO_SLUG = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$";

/** Workspace-repo prompt — driven by `sandbox setup`. */
export const _WORKSPACE_REPO_PROMPT: PromptSpec = {
  key: "workspace_repo",
  label: "Workspace config repo (owner/repo)",
  help:
    "GitHub repo cloned under the repos root and worktree'd as the root of " +
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
export function loadGithubOrg(cfg?: GlobalConfig): string {
  const c = cfg ?? load();
  const explicit = c["overrides"]?.["github_org"];
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return loadWorkspaceRepo(c).split("/")[0] ?? "";
}

/**
 * The Jira project key the sandbox tool's own issues go to
 * (`overrides.sandbox_issues_project`, e.g. `SW`), upper-cased; "" when unset
 * or not a key. Only read under `issue_tracker: jira`; unset keeps them on
 * GitHub (issues_report.ts's SANDBOX_ISSUES_REPO).
 */
export function loadSandboxIssuesProject(cfg?: GlobalConfig): string {
  const value = (cfg ?? load())["overrides"]?.["sandbox_issues_project"];
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9]+$/.test(key) ? key : "";
}

/** GitHub org/user prompt — driven by `sandbox setup`. */
export const _GITHUB_ORG_PROMPT: PromptSpec = {
  key: "github_org",
  label: "GitHub org for service repos",
  help:
    "Owner of the repos in your services registry. Used to link the " +
    "canonical examples that standards docs cite (github.com/<org>/<repo>).",
  acceptEmpty: false,
  pattern: "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$",
  placeholder: "your-org",
};

// A DNS domain: dot-separated labels, no scheme, no path, no trailing dot.
const _DOMAIN =
  "[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$";

/** Ingress prompts — driven by `sandbox setup`, alongside `_CONFIG_PROMPTS`. */
export const _INGRESS_PROMPTS: readonly PromptSpec[] = [
  {
    key: "local_domain",
    label: "Local ingress domain",
    help:
      "Base domain for docker features — each routed service is served at " +
      "<service>.<domain> and Caddy terminates TLS for it.",
    acceptEmpty: false,
    pattern: _DOMAIN,
    placeholder: INGRESS_DEFAULTS.local_domain,
  },
  {
    key: "remote_domain",
    label: "Remote (K8s) ingress domain",
    help:
      "Base domain for services routed to the dev cluster instead of a " +
      "local container — served at <service>.<domain>.",
    acceptEmpty: false,
    pattern: _DOMAIN,
    placeholder: INGRESS_DEFAULTS.remote_domain,
  },
  {
    key: "certs_dir",
    label: "Certificate directory (absolute path)",
    help:
      "Where bin/generate-certs.sh writes localhost.crt/.key; bind-mounted " +
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

/** Write the config YAML (creating ~/.werkmeister/ as needed). */
export function save(cfg: GlobalConfig): string {
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
export function renderEnvSh(cfg: GlobalConfig): string {
  const lines = [
    `# Generated by \`sandbox config\` from ${configPath()} — DO NOT EDIT.`,
    "# Sourced by ~/.zshenv and the `sandbox` wrapper for backward compatibility.",
  ];
  for (const [section, key, envVar] of _ENV_MAP) {
    const value = (cfg[section] as Record<string, unknown> | undefined)?.[key];
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

export function writeEnvSh(cfg: GlobalConfig): string {
  const p = envShPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderEnvSh(cfg));
  return p;
}

// ---------------------------------------------------------------------------
// ~/.zshenv managed block
// ---------------------------------------------------------------------------

function managedBlock(): string {
  const home = path.basename(dotDir(os.homedir()));
  return (
    `${_ZSH_BEGIN}\n` +
    "# Managed by `sandbox config` — do not edit; regenerated on `sandbox config`.\n" +
    `[ -f "$HOME/${home}/env.sh" ] && . "$HOME/${home}/env.sh"\n` +
    `${_ZSH_END}\n`
  );
}

/** Remove the block delimited by *begin* and *end*, plus any line matching *drop*. */
function stripBlock(
  text: string,
  begin: string,
  end: string,
  drop: (line: string) => boolean = () => false,
): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.trim() === begin) {
      inBlock = true;
      continue;
    }
    if (line.trim() === end) {
      inBlock = false;
      continue;
    }
    if (inBlock || drop(line)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** A legacy hardcoded SANDBOX_* export, which env.sh now owns. */
function isLegacyExport(line: string): boolean {
  const stripped = line.trim();
  return (
    stripped.startsWith("export ") &&
    _LEGACY_EXPORT_VARS.some((v) => stripped.slice("export ".length).startsWith(`${v}=`))
  );
}

/** Re-append *block* at the end of *target*, replacing any prior copy. Changed? */
function installBlock(target: string, body: string, block: string, original: string): boolean {
  const updated = (body ? body.replace(/\n+$/, "") + "\n\n" : "") + block;
  if (updated === original) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, updated);
  return true;
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
  const body = stripBlock(original, _ZSH_BEGIN, _ZSH_END, isLegacyExport);
  return installBlock(target, body, managedBlock(), original);
}

/**
 * Idempotently install `sandbox` tab completion in ~/.zshrc.
 *
 * `complete -C` is bash's protocol, reached in zsh through bashcompinit — one
 * `sandbox __complete` callback then serves both shells, with no generated
 * completion script to go stale. Appended last so an rc that runs `compinit`
 * itself (oh-my-zsh and friends) has already done so. The guards cover the rc
 * that never does — bashcompinit would fail with "compdef: not found" — and the
 * shell where even our own `compinit` cannot run (a non-interactive zsh sourcing
 * the rc), where the block must stay silent rather than spill errors.
 *
 * Returns true if the file content changed. zsh only — bash users have the
 * two-line snippet in the README.
 */
export function ensureZshrcCompletion(p?: string): boolean {
  const target = p ?? zshrcPath();
  const original = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const body = stripBlock(original, _COMPLETION_BEGIN, _COMPLETION_END);
  const block =
    `${_COMPLETION_BEGIN}\n` +
    "# Managed by `sandbox setup` — do not edit; regenerated on `sandbox setup`.\n" +
    "if (( $+commands[sandbox] )); then\n" +
    "  (( $+functions[compdef] )) || { autoload -Uz compinit && compinit }\n" +
    "  if (( $+functions[compdef] )); then\n" +
    "    autoload -Uz +X bashcompinit && bashcompinit\n" +
    "    complete -C 'sandbox __complete' sandbox\n" +
    "  fi\n" +
    "fi\n" +
    `${_COMPLETION_END}\n`;
  return installBlock(target, body, block, original);
}

// ---------------------------------------------------------------------------
// claude_desktop_config.json
// ---------------------------------------------------------------------------

/** A sandbox MCP server: command basename `sandbox` invoked with `mcp`. */
function isSandboxServer(body: Record<string, unknown>): boolean {
  const command = String(body["command"] ?? "");
  const args = (body["args"] as unknown[] | undefined) ?? [];
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
  let data: { mcpServers?: Record<string, unknown> };
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
export function check(cfg: GlobalConfig): string[] {
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
            `${dpath}: sandbox server still has a stale \`env\` block — ` + "run `sandbox config`",
          );
        }
      }
    } catch {
      // malformed Desktop config isn't ours to diagnose here
    }
  }

  return problems;
}
