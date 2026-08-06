/**
 * sandbox init-workspace [options]
 *
 * Reconcile a sandbox workspace from its `.sandbox/workspace.yml` and
 * (re)generate its context files. This is the config-driven half of workspace
 * management: `sandbox workspace` creates the workspace ROOT and writes
 * workspace.yml; `init-workspace` (run there, by `workspace` or directly)
 * does the rest and is idempotent — edit workspace.yml and rerun to apply changes.
 *
 * Two responsibilities:
 *
 * 1. Reconcile the nested per-repo git worktrees against the desired set — the
 *    union of workspace.yml's `repos` and the repos owning its `services`.
 *    Missing repos are added as worktrees; repos dropped from the config have
 *    their worktrees removed (a dirty worktree aborts the run unless `--force`).
 * 2. Generate/overwrite CLAUDE.md, .env, docker-compose.yml, the projected
 *    .claude/ skills+agents, .mcp.json, and .sandbox/* from that config.
 *
 * It refuses to run against a bare directory (no workspace.yml and no --feature),
 * pointing the user at `sandbox workspace` — it never prompts (the interactive
 * wizard lives in `sandbox workspace`).
 *
 * The workspace root is inferred from CWD: the script honours
 * SANDBOX_WORKSPACES_ROOT (then SANDBOX_WORKSPACE_ROOT and WORKSPACE for
 * back-compat, then ~/workspace) and walks up to the first direct child of the
 * configured root, falling back to a parent-of-.git auto-detect when CWD is
 * not under a configured root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as YAML from "yaml";

import { buildTesterSpecs, writeWorkspaceAgents } from "../lib/agent_gen.js";
import { resolvePresentArchetypes } from "../lib/archetypes.js";
import { buildClaudeMd, buildStandardsRoutingSection } from "../lib/claude_md.js";
import {
  Colors,
  claudeSessionCommand,
  error,
  getReposRoot,
  info,
  loadArchetypes,
  loadMcpServers,
  loadReposConfig,
  loadServices,
  success,
  warn,
} from "../lib/config.js";
import { buildFormSchema } from "../lib/form_schema.js";
import { generateWorkspaceCompose } from "../lib/generate.js";
import { loadPaths } from "../lib/global_config.js";
import { writeWorkspaceHooks } from "../lib/hooks_gen.js";
import { WORKSPACE_ROOT_REPO } from "../lib/machine_setup.js";
import {
  resolveWorkspaceMcpServers,
  validateArchetypeMcpServers,
  writeWorkspaceMcp,
} from "../lib/mcp_gen.js";
import { listNotes, nextNoteNumber, noteFilename, notesDir } from "../lib/notes.js";
import { pluginDriftWarnings } from "../lib/plugin_check.js";
import {
  buildStandardsManifest,
  loadStandardsModules,
  resolveActiveStandards,
  validateServiceStandards,
  writeStandardsManifest,
} from "../lib/standards.js";
import { PromptSpec, runWizard } from "../lib/wizard.js";
import { writeWorkspaceSkills } from "../lib/workspace_skills.js";
import {
  createWorktree,
  removeWorktree,
  resolveRepos,
  worktreeIsDirty,
  writeWorkspaceGitignore,
} from "../lib/worktrees.js";
import { run as procRun } from "../lib/proc.js";
import { ProcError } from "../lib/proc.js";

// SystemExit raised by _findWorkspaceRoot; caught by the print paths and run().
class WorkspaceRootError extends Error {}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** getpass.getuser() equivalent: env-driven with pwd fallback. */
function getuser(): string {
  for (const name of ["LOGNAME", "USER", "LNAME", "USERNAME"]) {
    const v = process.env[name];
    if (v) return v;
  }
  return os.userInfo().username;
}

/**
 * `json.dump`/`json.dumps` byte-parity. `indent=null` mirrors the default
 * separators `(", ", ": ")`; a number mirrors `indent=N`. ensure_ascii=True in
 * both (non-ASCII → \uXXXX). Used for the two pure-output paths so stdout
 * matches the Python CLI byte-for-byte.
 */
function pyJson(value: unknown, indent: number | null = null, level = 0): string {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") {
    return value === undefined ? "null" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u0080-\uffff]/g,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (indent === null) {
      return "[" + value.map((v) => pyJson(v, null)).join(", ") + "]";
    }
    const pad = " ".repeat(indent * (level + 1));
    const padEnd = " ".repeat(indent * level);
    return "[\n" + value.map((v) => pad + pyJson(v, indent, level + 1)).join(",\n") + "\n" + padEnd + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  if (indent === null) {
    return "{" + entries.map(([k, v]) => `${pyJson(k, null)}: ${pyJson(v, null)}`).join(", ") + "}";
  }
  const pad = " ".repeat(indent * (level + 1));
  const padEnd = " ".repeat(indent * level);
  const items = entries.map(([k, v]) => pad + pyJson(k, indent, level + 1) + ": " + pyJson(v, indent, level + 1));
  return "{\n" + items.join(",\n") + "\n" + padEnd + "}";
}

/** Run *fn* with stdout diagnostics rerouted to stderr (contextlib.redirect_stdout). */
function withStdoutToStderr<T>(fn: () => T): T {
  const orig = console.log;
  console.log = (...a: unknown[]) => console.error(...(a as []));
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

// ---------------------------------------------------------------------------
// Workspace config parsing
//
// Preferred format is YAML (`workspace.yml`) — native comment support, more
// readable than JSON. JSONC and legacy JSON are still read for back-compat.
// ---------------------------------------------------------------------------

/** Strip `//` and `/* *\/` comments from JSONC text. Respects string literals. */
function stripJsoncComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      if (ch === "\\" && i + 1 < n) {
        out.push(text[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && i + 1 < n) {
      const nxt = text[i + 1];
      if (nxt === "/") {
        i += 2;
        while (i < n && text[i] !== "\n") {
          i += 1;
        }
        continue;
      }
      if (nxt === "*") {
        i += 2;
        while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) {
          i += 1;
        }
        i += 2;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/**
 * Parse a workspace config file. Dispatches by extension: `.yaml`/`.yml` →
 * yaml parse; `.jsonc`/`.json` → JSONC-strip then JSON.parse.
 */
function loadWorkspaceConfig(p: string): any {
  const text = fs.readFileSync(p, "utf8");
  const suffix = path.extname(p);
  if (suffix === ".yaml" || suffix === ".yml") {
    return YAML.parse(text);
  }
  return JSON.parse(stripJsoncComments(text));
}

// ---------------------------------------------------------------------------
// Input resolution (CLI flag > env var > config file > default).
// ---------------------------------------------------------------------------

// Keys are [cliAttr, envVar, configField], consulted in order CLI > env > config.
const _INPUT_FIELDS: ReadonlyArray<[string, string, string]> = [
  ["feature", "SANDBOX_FEATURE", "feature"],
  ["work_type", "SANDBOX_WORK_TYPE", "work_type"],
  ["repos", "SANDBOX_REPOS", "repos"],
  ["services", "SANDBOX_SERVICES", "services"],
  ["jira_id", "SANDBOX_JIRA_ID", "jira_id"],
  ["test_path", "SANDBOX_TEST_PATH", "test_path"],
  ["description", "SANDBOX_DESCRIPTION", "description"],
  ["task", "SANDBOX_TASK", "task"],
  ["starting_prompt", "SANDBOX_STARTING_PROMPT", "starting_prompt"],
  ["labels", "SANDBOX_LABELS", "labels"],
];

// Config fields persisted as a real YAML list rather than a comma-joined string.
const _LIST_VALUED_FIELDS = new Set<string>(["labels"]);

/** Comma-separated string -> trimmed, non-empty list items. */
function splitMultiValue(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s);
}

// Workspace config filenames in search-order precedence: preferred YAML first,
// then legacy JSONC/JSON kept readable for back-compat. workspace.yml is also
// the canonical write target (the rest are migrated to it on the next write).
const _WORKSPACE_CONFIG_NAMES = [
  "workspace.yml",
  "workspace.yaml",
  "workspace.jsonc",
  "workspace.json",
] as const;

/**
 * Resolve and parse the workspace config file. Returns an empty object when the
 * resolved path does not exist or is malformed (parse errors warn rather than
 * crash — a typo should never block init-workspace).
 */
export function loadConfigFile(workspaceRoot: string, override: string | null): Record<string, any> {
  const candidates: string[] = [];
  if (override) {
    candidates.push(expandUserPath(override));
  }
  const envOverride = process.env["SANDBOX_WORKSPACE_CONFIG"];
  if (envOverride) {
    candidates.push(expandUserPath(envOverride));
  }
  const sandbox = path.join(workspaceRoot, ".sandbox");
  for (const name of _WORKSPACE_CONFIG_NAMES) {
    candidates.push(path.join(sandbox, name));
  }

  for (const p of candidates) {
    if (!fs.existsSync(p)) {
      continue;
    }
    let data: any;
    try {
      data = loadWorkspaceConfig(p);
    } catch (exc) {
      warn(`Config file ${p} unreadable: ${(exc as Error).message} — skipping.`);
      return {};
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      warn(`Config file ${p} must be a mapping — skipping.`);
      return {};
    }
    info(`Loaded workspace config from ${p}`);
    return data;
  }

  return {};
}

/** Expand a leading `~`. Mirrors Path(...).expanduser() (no cwd resolution). */
function expandUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * True if a workspace config file exists (any search-order name, or an explicit
 * --config / SANDBOX_WORKSPACE_CONFIG override that resolves).
 */
function hasWorkspaceConfig(workspaceRoot: string, override: string | null): boolean {
  if (override && fs.existsSync(expandUserPath(override))) {
    return true;
  }
  const envOverride = process.env["SANDBOX_WORKSPACE_CONFIG"];
  if (envOverride && fs.existsSync(expandUserPath(envOverride))) {
    return true;
  }
  const sandbox = path.join(workspaceRoot, ".sandbox");
  return _WORKSPACE_CONFIG_NAMES.some((name) => fs.existsSync(path.join(sandbox, name)));
}

// Editors (redhat.vscode-yaml) validate against the schema named by the
// `# yaml-language-server` modeline below; the `$schema` key we also emit is
// the machine-readable pointer for other tooling.
const _WORKSPACE_SCHEMA_URL =
  "https://raw.githubusercontent.com/jbbz-sandbox/sandbox/" +
  "main/infra/schemas/workspace.schema.json";

const _WORKSPACE_CONFIG_HEADER =
  `# yaml-language-server: $schema=${_WORKSPACE_SCHEMA_URL}\n` +
  "# AUTO-GENERATED — durable source of truth for workspace inputs.\n" +
  "# Tool:    sandbox init-workspace\n" +
  "# Source:  src/commands/init_workspace.ts :: _write_workspace_config\n" +
  "# Edit:    Hand-edit `feature`, `repos`, `services`, `jira_id`, `task`,\n" +
  "#          `test_path`, `description`, `labels`, or `starting_prompt` below; rerun\n" +
  "#          `sandbox init-workspace` to propagate changes into\n" +
  "#          CLAUDE.md / .env / docker-compose.yml / .sandbox/*.\n" +
  "#          Adding/removing a repo here reconciles git worktrees on rerun;\n" +
  "#          removing a repo with uncommitted edits needs `--force`.\n" +
  "#          Optional `standards_override: {add: [...], remove: [...]}` tunes\n" +
  "#          the CLAUDE.md Standards routing block (docs/jit-context-system.md).\n" +
  "#          To register a brand-new service, edit\n" +
  "#          ~/.sandbox/services.yaml instead.\n" +
  "# Format:  YAML — line comments (`#`) are supported. The loader also\n" +
  "#          accepts legacy JSONC and JSON for back-compat.\n";

/**
 * Persist resolved inputs to `<workspace>/.sandbox/workspace.yml`. Preserves
 * unmanaged keys, skips a no-op write, and migrates legacy workspace.yaml /
 * .jsonc / .json to workspace.yml.
 *
 * ponytail: PyYAML byte-parity is not contractual on this write path (only the
 * two --print-* paths are). yaml v2 block-styles multi-line strings and
 * sortMapEntries sorts keys the same as PyYAML sort_keys=True.
 */
export function writeWorkspaceConfig(workspaceRoot: string, resolved: Record<string, string>): void {
  if (Object.keys(resolved).length === 0) {
    return;
  }
  const sandboxDir = path.join(workspaceRoot, ".sandbox");
  const target = path.join(sandboxDir, _WORKSPACE_CONFIG_NAMES[0]);
  const legacies = _WORKSPACE_CONFIG_NAMES.slice(1).map((name) => path.join(sandboxDir, name));

  let existing: Record<string, any> = {};
  for (const source of [target, ...legacies]) {
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      try {
        const data = loadWorkspaceConfig(source);
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
          existing = data;
          break;
        }
      } catch {
        // malformed → fall through to fresh write
      }
    }
  }
  // Drop the legacy `_generator` key — its job is now done by the header comment.
  delete existing["_generator"];
  const merged: Record<string, any> = { ...existing };
  // `$` sorts before letters, so sort places this first — matching the modeline.
  merged["$schema"] = _WORKSPACE_SCHEMA_URL;
  for (const [, , field] of _INPUT_FIELDS) {
    if (field in resolved) {
      let value: string | string[] = resolved[field];
      if (_LIST_VALUED_FIELDS.has(field) && typeof value === "string") {
        value = splitMultiValue(value);
      }
      merged[field] = value;
    }
  }
  const body = YAML.stringify(merged, { sortMapEntries: true, blockQuote: "literal" });
  const serialized = _WORKSPACE_CONFIG_HEADER + body;
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === serialized) {
    return; // no-op write — same content
  }
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.writeFileSync(target, serialized);
  success(`Persisted inputs to ${target}`);
  for (const legacy of legacies) {
    if (fs.existsSync(legacy)) {
      fs.unlinkSync(legacy);
      info(`Removed legacy ${path.basename(legacy)} (superseded by workspace.yml)`);
    }
  }
}

/**
 * Read the metadata keys already present in `<workspace>/.env` so a bare re-run
 * preserves prior workspace config. Only `_INPUT_FIELDS` keys are returned
 * (UPPER_SNAKE → lowercase config-field form).
 */
function loadExistingEnvMetadata(workspaceRoot: string): Record<string, string> {
  const envPath = path.join(workspaceRoot, ".env");
  if (!(fs.existsSync(envPath) && fs.statSync(envPath).isFile())) {
    return {};
  }
  const wanted: Record<string, string> = {};
  for (const [, , field] of _INPUT_FIELDS) {
    wanted[field.toUpperCase()] = field;
  }
  const found: Record<string, string> = {};
  for (let line of fs.readFileSync(envPath, "utf8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key in wanted) {
      found[wanted[key]] = value.trim();
    }
  }
  return found;
}

/**
 * Resolve every input field per the documented precedence
 * (CLI flag > SANDBOX_* env var > config file > existing .env > unset).
 */
export function resolveInputs(args: Record<string, unknown>, workspaceRoot: string): Record<string, string> {
  const configData = loadConfigFile(workspaceRoot, (args["config_file"] as string | null) ?? null);
  const existingEnv = loadExistingEnvMetadata(workspaceRoot);
  const resolved: Record<string, string> = {};

  for (const [cliAttr, envVar, configField] of _INPUT_FIELDS) {
    const cliValue = args[cliAttr] ?? null;
    const envValue = process.env[envVar] ?? null;
    const cfgValue = configField in configData ? configData[configField] : null;
    const envFileValue = configField in existingEnv ? existingEnv[configField] : null;
    for (const source of [cliValue, envValue, cfgValue, envFileValue]) {
      if (source === null || source === undefined) {
        continue;
      }
      // A multi-value field may arrive from YAML as a list; downstream expects a
      // comma-separated string, so join rather than str()-ing the list.
      let text: string;
      if (Array.isArray(source)) {
        text = source
          .map((item) => String(item).trim())
          .filter((item) => item)
          .join(",");
      } else {
        text = String(source).trim();
      }
      if (text) {
        resolved[configField] = text;
        break;
      }
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Interactive wizard
// ---------------------------------------------------------------------------

const _JIRA_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/** Derive a kebab-case feature default from the workspace dir name. */
function defaultFeatureFromDir(workspaceName: string): string {
  let parts = workspaceName.split("-");
  if (parts.length && parts[0].length === 4 && [...parts[0].toLowerCase()].every((c) => "0123456789abcdef".includes(c))) {
    parts = parts.slice(1);
  }
  return parts.length ? parts.join("-") : workspaceName;
}

/** Best-effort: scan each immediate-child repo's branch for a Jira-like key. */
function scrapeJiraId(workspaceRoot: string): string {
  for (const name of fs.readdirSync(workspaceRoot).sort()) {
    const entry = path.join(workspaceRoot, name);
    if (!isDir(entry) || name.startsWith(".")) {
      continue;
    }
    let result;
    try {
      result = procRun(["git", "-C", entry, "branch", "--show-current"], {
        capture: true,
        timeout: 5,
      });
    } catch (exc) {
      if (exc instanceof ProcError && (exc.code === "ENOENT" || exc.code === "ETIMEDOUT")) {
        continue;
      }
      throw exc;
    }
    if (result.status !== 0) {
      continue;
    }
    const match = _JIRA_RE.exec(result.stdout);
    if (match) {
      return match[1];
    }
  }
  return "";
}

// Work type → (seeded note phase, first entry-skill sentence).
const WORK_TYPE_PHASES: Record<string, [string, string]> = {
  feature: ["research", "invoke `sb-research` first to explore and spec the work"],
  bugfix: [
    "research",
    "invoke `sb-research` first to reproduce and locate the root cause before changing code",
  ],
  refactor: [
    "implement",
    "invoke `sb-implement` first — the scope is known and standards matter most",
  ],
  spike: ["research", "invoke `sb-research` first to frame the questions this spike must answer"],
  incident: ["research", "invoke `sb-research` first to diagnose before changing anything"],
};
const WORK_TYPES: string[] = Object.keys(WORK_TYPE_PHASES);

const _WIZARD_PROMPTS: readonly PromptSpec[] = [
  {
    key: "jira_id",
    label: "Jira ID (blank to skip)",
    help:
      "Renders a clickable ticket link in CLAUDE.md. Fill it first — the " +
      "browser form's “Fetch from Jira” button uses it to pre-fill the rest.",
    pattern: "^[A-Z][A-Z0-9]+-[0-9]+$",
    placeholder: "PROJ-1234",
    defaultFn: (ws) => scrapeJiraId(ws),
  },
  {
    key: "feature",
    label: "Feature name (lowercase, hyphen-separated)",
    help:
      "Drives sandbox slot routing via the X-Feature cookie. " +
      "No feature = no docker-compose.yml / sandbox-context.md.",
    acceptEmpty: false,
    recommended: true,
    pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
    placeholder: "mdx-blog",
    defaultFn: (ws) => defaultFeatureFromDir(path.basename(ws)),
  },
  {
    key: "work_type",
    label: "Work type",
    help:
      "What kind of work this is; seeds the first-phase handoff note " +
      "(research vs implement) for the workspace's first session.",
    acceptEmpty: false,
    pattern: "^(" + Object.keys(WORK_TYPE_PHASES).join("|") + ")$",
    defaultFn: () => "feature",
    choicesFn: () => [...WORK_TYPES],
  },
  {
    key: "services",
    label: "Local services (comma-separated, blank = none)",
    help: "Services to run locally with hot-reload; the rest fall through to k8s port-forwards.",
    multi: true,
    choicesFn: () => Object.keys(loadSandboxServiceConfigs()[0]).sort(),
  },
  {
    key: "labels",
    label: "Labels (comma-separated, blank = none)",
    help: "Free-form tags for filtering workspaces in the dashboard search.",
    multi: true,
  },
  {
    key: "test_path",
    label: "Feature test path (blank to skip)",
    help: "URL path for the feature entry point, appended to the routed host.",
    pattern: "^/\\S*$",
    placeholder: "/products/foo",
  },
  {
    key: "task",
    label: "Task title (Enter for default)",
    help: "Short title for the Current Task section; derived from the workspace dir name if blank.",
    defaultFn: (ws) => slugToTask(path.basename(ws)),
  },
  {
    key: "description",
    label: "Task description (blank to skip)",
    help:
      "1-2 sentences on what the feature does and the user-visible outcome; " +
      "rendered under Current Task in CLAUDE.md.",
    placeholder: "Adds an MDX-powered blog index under /blog.",
  },
  {
    key: "starting_prompt",
    label: "Starting prompt (blank to skip)",
    help:
      "The first instruction to hand the agent in this workspace; " +
      "persisted to .sandbox/workspace.yml.",
    multiline: true,
    refinable: true,
    refineInstruction:
      "Rewrite the user's text as a clear, specific, actionable starting instruction for a coding agent " +
      "beginning a development task, preserving the user's intent. The rewritten instruction must state " +
      "the goal — the desired end state and why it matters — and must include explicit acceptance criteria: " +
      "a checklist of concrete, verifiable conditions that define when the task is done. Derive the goal and " +
      "acceptance criteria from the user's text wherever possible; for any that cannot be confidently derived, " +
      "the rewritten instruction must direct the agent to ask the user to supply them before proceeding, " +
      "rather than guessing.",
  },
];

/** Prompt for any input `resolveInputs` didn't fill in (unused by run — the
 * wizard lives in `sandbox workspace`; kept for structural parity). */
export async function runInteractiveWizard(
  workspaceRoot: string,
  resolved: Record<string, string>,
  extraPrompts: readonly PromptSpec[] = [],
): Promise<Record<string, string>> {
  // Workspace-only prompts (e.g. `repos`) are spliced in right after `services`
  // so the terminal wizard presents the same fields, in the same order, as
  // `--print-prompts` / the browser form (which inject them at the same spot).
  const prompts: PromptSpec[] = [..._WIZARD_PROMPTS];
  if (extraPrompts.length) {
    const idx = prompts.findIndex((p) => p.key === "services");
    prompts.splice(idx === -1 ? prompts.length : idx + 1, 0, ...extraPrompts);
  }
  return runWizard(
    prompts,
    resolved,
    (spec) => (spec.defaultFn ? spec.defaultFn(workspaceRoot) : ""),
    { intro: "Interactive wizard — press Ctrl-C to abort. Defaults shown in [brackets]." },
  );
}

/** Serialise one PromptSpec to a JSON-ready entry, resolved against the workspace. */
export function promptEntry(
  spec: PromptSpec,
  workspaceRoot: string,
  resolved: Record<string, string>,
): Record<string, any> {
  const entry: Record<string, any> = {
    key: spec.key,
    label: spec.label,
    help: spec.help,
    accept_empty: spec.acceptEmpty ?? true,
    multi: spec.multi ?? false,
    recommended: spec.recommended ?? false,
    default: spec.defaultFn ? spec.defaultFn(workspaceRoot) : "",
    resolved: spec.key in resolved,
    resolved_value: spec.key in resolved ? resolved[spec.key] : null,
  };
  if (spec.multiline) {
    entry["multiline"] = true;
  }
  if (spec.refinable) {
    entry["refinable"] = true;
    if (spec.refineInstruction) {
      entry["refine_instruction"] = spec.refineInstruction;
    }
  }
  if (spec.pattern) {
    entry["pattern"] = spec.pattern;
  }
  if (spec.placeholder) {
    entry["placeholder"] = spec.placeholder;
  }
  if (spec.choicesFn) {
    entry["choices"] = spec.choicesFn();
  }
  return entry;
}

/** Serialise `_WIZARD_PROMPTS` to JSON-ready data for external drivers. */
export function buildPromptSpec(workspaceRoot: string, resolved: Record<string, string>): Record<string, any> {
  return {
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    prompts: _WIZARD_PROMPTS.map((spec) => promptEntry(spec, workspaceRoot, resolved)),
  };
}

/** Resolve inputs and build the prompt spec, with all diagnostics on stderr. */
function computePromptSpec(args: Record<string, unknown>): Record<string, any> {
  return withStdoutToStderr(() => {
    const workspaceRoot = findWorkspaceRoot();
    const resolved = resolveInputs(args, workspaceRoot);
    return buildPromptSpec(workspaceRoot, resolved);
  });
}

/** Emit the standard {"error": …, "prompts": []} JSON and exit 1. */
export function emitSpecError(exc: unknown): void {
  const raw = exc instanceof Error ? exc.message : String(exc);
  const message = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
  process.stdout.write(pyJson({ error: message, prompts: [] }) + "\n");
  process.exit(1);
}

/** Handle `sandbox init-workspace --print-prompts`. */
function printPrompts(args: Record<string, unknown>): void {
  let spec: Record<string, any>;
  try {
    spec = computePromptSpec(args);
  } catch (exc) {
    if (exc instanceof WorkspaceRootError) {
      emitSpecError(exc);
      return;
    }
    throw exc;
  }
  process.stdout.write(pyJson(spec, 2) + "\n");
}

/** Handle `sandbox init-workspace --print-form-schema`. */
function printFormSchema(args: Record<string, unknown>): void {
  let spec: Record<string, any>;
  try {
    spec = computePromptSpec(args);
  } catch (exc) {
    if (exc instanceof WorkspaceRootError) {
      emitSpecError(exc);
      return;
    }
    throw exc;
  }
  process.stdout.write(pyJson(buildFormSchema(spec), 2) + "\n");
}

// ---------------------------------------------------------------------------
// Workspace detection
// ---------------------------------------------------------------------------

// Infrastructure service names that are not interesting as app-level dependencies.
const _INFRA_DEPS = new Set<string>(["redis", "postgres", "mongodb"]);

/** Build the search order for the sandbox workspaces-container directory. */
function candidateWorkspaceRoots(): string[] {
  const roots: string[] = [];
  const configured = loadPaths()["workspaces_root"];
  if (configured) {
    roots.push(path.resolve(expandUserPath(configured)));
  }
  roots.push(path.join(os.homedir(), "workspace"));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of roots) {
    if (!seen.has(r)) {
      seen.add(r);
      unique.push(r);
    }
  }
  return unique;
}

/** Resolve the feature-workspace directory containing the current invocation. */
function findWorkspaceRoot(): string {
  const cwd = path.resolve(process.cwd());

  for (const root of candidateWorkspaceRoots()) {
    const rel = path.relative(root, cwd);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      continue;
    }
    if (rel === "") {
      // CWD is the workspace root itself — no feature dir to select.
      continue;
    }
    return path.join(root, rel.split(path.sep)[0]);
  }

  for (const directory of [cwd, ...ancestors(cwd)]) {
    if (fs.existsSync(path.join(directory, ".git"))) {
      return path.dirname(directory);
    }
  }

  const rootsDisplay = candidateWorkspaceRoots().join(", ");
  throw new WorkspaceRootError(
    `${Colors.RED}[err]  Not inside a sandbox workspace (checked: ` +
      `${rootsDisplay}) and no parent \`.git\` directory found.\n` +
      "       The workspaces root comes from ~/.sandbox/config.yaml — run " +
      "`sandbox config` to set it (or `sandbox config --check` to verify). " +
      `See docs/known-issues.md for details.${Colors.RESET}`,
  );
}

/** Path.parents equivalent: ancestor directories from immediate parent up to root. */
function ancestors(p: string): string[] {
  const result: string[] = [];
  let cur = p;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    result.push(parent);
    cur = parent;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

/** Return True if *path* is the root of a git repo or worktree. */
function isGitRepo(p: string): boolean {
  const result = procRun(["git", "-C", p, "rev-parse", "--git-dir"], { capture: true });
  return result.status === 0;
}

/** Return the current branch name, or the short commit hash if detached. */
function getBranch(p: string): string {
  const result = procRun(["git", "-C", p, "branch", "--show-current"], { capture: true });
  const branch = result.stdout.trim();
  if (branch) {
    return branch;
  }
  const result2 = procRun(["git", "-C", p, "rev-parse", "--short", "HEAD"], { capture: true });
  return result2.stdout.trim() || "unknown";
}

/** (dir_name, branch) for every immediate subdir that is a git repo/worktree, sorted. */
function discoverRepos(workspaceRoot: string): Array<[string, string]> {
  const repos: Array<[string, string]> = [];
  for (const name of fs.readdirSync(workspaceRoot).sort()) {
    const entry = path.join(workspaceRoot, name);
    if (!isDir(entry) || name.startsWith(".")) {
      continue;
    }
    if (isGitRepo(entry)) {
      repos.push([name, getBranch(entry)]);
    }
  }
  return repos;
}

// ---------------------------------------------------------------------------
// Repo-worktree reconciliation
// ---------------------------------------------------------------------------

/** Branch every nested worktree should sit on: `<user>/<workspace>`. */
function workspaceBranch(workspaceRoot: string): string {
  if (fs.existsSync(path.join(workspaceRoot, ".git"))) {
    const branch = getBranch(workspaceRoot);
    if (branch && branch !== "unknown") {
      return branch;
    }
  }
  return `${getuser()}/${path.basename(workspaceRoot)}`;
}

/** Create missing repo worktrees and remove ones no longer desired. */
function reconcileWorktrees(workspaceRoot: string, desiredRepos: string[], force: boolean): void {
  const reposRoot = getReposRoot();
  const desired = desiredRepos.filter((r) => r !== WORKSPACE_ROOT_REPO);
  const desiredSet = new Set(desired);
  const present = new Set(discoverRepos(workspaceRoot).map(([name]) => name));

  const toCreate = desired.filter((r) => !present.has(r));
  const toRemove = [...present].filter((r) => !desiredSet.has(r)).sort();

  const missingSrc = toCreate.filter((r) => !isDir(path.join(reposRoot, r)));
  if (missingSrc.length) {
    error(
      `Source repo(s) not found under ${reposRoot}: ${missingSrc.join(", ")}. ` +
        "Clone them there (or fix `repos` in .sandbox/workspace.yml) and rerun.",
    );
    process.exit(1);
  }

  // Pre-flight: a dirty removal aborts the whole run without changes.
  if (toRemove.length && !force) {
    const dirty = toRemove.filter((r) => worktreeIsDirty(path.join(workspaceRoot, r)));
    if (dirty.length) {
      error(
        `Refusing to remove worktree(s) with uncommitted changes: ${dirty.join(", ")}. ` +
          "Commit or stash them, or rerun with --force to discard them.",
      );
      process.exit(1);
    }
  }

  if (!toCreate.length && !toRemove.length) {
    return;
  }

  const branch = workspaceBranch(workspaceRoot);

  for (const repo of toRemove) {
    const [ok, message] = removeWorktree(
      path.join(reposRoot, repo),
      path.join(workspaceRoot, repo),
      branch,
    );
    if (ok) {
      success(`Removed worktree '${repo}' (no longer in workspace.yml).`);
      if (message) {
        warn(message);
      }
    } else {
      error(`Could not remove worktree '${repo}': ${message}`);
      process.exit(1);
    }
  }

  const created: Array<[string, string]> = []; // [dest, src]
  try {
    for (const repo of toCreate) {
      const src = path.join(reposRoot, repo);
      const dest = path.join(workspaceRoot, repo);
      createWorktree(src, dest, branch);
      created.push([dest, src]);
    }
  } catch (exc) {
    error(`Failed to create worktree: ${(exc as Error).message}`);
    warn("Rolling back worktrees created this run...");
    for (const [dest, src] of [...created].reverse()) {
      removeWorktree(src, dest, branch);
    }
    process.exit(1);
  }

  if (toCreate.length || toRemove.length) {
    success(`Worktrees reconciled (+${toCreate.length} / -${toRemove.length}).`);
  }
}

// ---------------------------------------------------------------------------
// Workspace metadata parser
// ---------------------------------------------------------------------------

const _META_KEY_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** Extract all KEY=VALUE pairs from a ```env fenced block in *description*. */
function parseWorkspaceMeta(description: string | null | undefined): Record<string, string> {
  if (!description) {
    return {};
  }
  // Normalize markdown escape sequences: \` → ` and \_ → _
  const normalized = description.split("\\`").join("`").split("\\_").join("_");
  const fence = /```(?:\.?env|workspace)\s*\n([\s\S]*?)```/i.exec(normalized);
  if (!fence) {
    return {};
  }
  const meta: Record<string, string> = {};
  for (const line of fence[1].split("\n")) {
    const m = _META_KEY_RE.exec(line.trim());
    if (m && !(m[1] in meta)) {
      meta[m[1]] = m[2].trim();
    }
  }
  return meta;
}
void parseWorkspaceMeta;

/** Return the current git branch from CWD, or null. */
function gitBranchCwd(): string | null {
  try {
    const result = procRun(["git", "branch", "--show-current"], { capture: true, timeout: 5 });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
void gitBranchCwd;

// ---------------------------------------------------------------------------
// Task description helpers
// ---------------------------------------------------------------------------

/** Convert a workspace dir name into a human-readable task hint. */
function slugToTask(workspaceName: string): string {
  let parts = workspaceName.split("-");
  if (parts.length && parts[0].length === 4 && [...parts[0].toLowerCase()].every((c) => "0123456789abcdef".includes(c))) {
    parts = parts.slice(1);
  }
  return parts.length
    ? parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ")
    : workspaceName;
}

/** Resolve the task title (args_task > stdin > slug-derived hint). */
function resolveTask(
  argsTask: string | null | undefined,
  workspaceName: string,
  _workspaceRoot: string,
): [string, Record<string, string>] {
  if (argsTask) {
    return [argsTask.trim(), {}];
  }

  if (!process.stdin.isTTY) {
    let task = "";
    try {
      task = fs.readFileSync(0, "utf8").trim();
    } catch {
      task = "";
    }
    if (task) {
      return [task, {}];
    }
  }

  return [slugToTask(workspaceName), {}];
}

// ---------------------------------------------------------------------------
// Sandbox config loading
// ---------------------------------------------------------------------------

/** Load services and repos config from services.yaml. Both may be empty. */
export function loadSandboxServiceConfigs(): [Record<string, any>, Record<string, any>] {
  try {
    return [loadServices(), loadReposConfig()];
  } catch {
    return [{}, {}];
  }
}

// ---------------------------------------------------------------------------
// Service map generation  (.sandbox/service-map.md)
// ---------------------------------------------------------------------------

/** Generate .sandbox/service-map.md — repos → services → package paths. */
function buildServiceMapMd(
  repos: Array<[string, string]>,
  servicesConfig: Record<string, any>,
  reposConfig: Record<string, any>,
  localServices: string[] | null = null,
): string {
  const localSet = new Set(localServices ?? []);
  const repoNames = new Set(repos.map(([name]) => name));
  const sections: string[] = [];

  for (const repoName of [...repoNames].sort()) {
    // Prefer the ordered list from reposConfig; fall back to scanning servicesConfig.
    let svcNames: string[] = (reposConfig[repoName] ?? {})["services"] ?? [];
    if (!svcNames.length) {
      svcNames = Object.entries(servicesConfig)
        .filter(([, cfg]) => typeof cfg === "object" && cfg !== null && !Array.isArray(cfg) && cfg["repo"] === repoName)
        .map(([svc]) => svc)
        .sort();
    }
    if (!svcNames.length) {
      continue;
    }

    // Local services first (preserve repo order within each group).
    if (localSet.size) {
      svcNames = [...svcNames.filter((s) => localSet.has(s)), ...svcNames.filter((s) => !localSet.has(s))];
    }

    const rows: string[] = [];
    for (const svc of svcNames) {
      const svcDef = servicesConfig[svc];
      if (!svcDef || typeof svcDef !== "object" || Array.isArray(svcDef)) {
        continue;
      }
      const p = svcDef["path"] ?? ".";
      const svcType = svcDef["type"] ?? "";
      const port = svcDef["internal_port"] ?? "";
      const rawDeps: string[] = svcDef["depends_on"] ?? [];
      const appDeps = (rawDeps || []).filter((d) => !_INFRA_DEPS.has(d));
      const depsStr = appDeps.length ? appDeps.map((d) => `\`${d}\``).join(", ") : "—";
      const mode = localSet.has(svc) ? "local" : "k8s";
      rows.push(`| \`${svc}\` | ${mode} | \`${p}\` | ${svcType} | ${port} | ${depsStr} |`);
    }

    if (!rows.length) {
      continue;
    }

    const table =
      "| Service | Mode | Path in repo | Type | Port | App dependencies |\n" +
      "|---------|------|-------------|------|------|------------------|\n" +
      rows.join("\n");
    sections.push(`## ${repoName}\n\n${table}`);
  }

  if (!sections.length) {
    return "";
  }

  const header =
    "<!--\n" +
    "  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.\n" +
    "  Source:    ~/.sandbox/services.yaml (service registry)\n" +
    "             + .sandbox/workspace.yml (feature local_services)\n" +
    "  Generator: src/commands/init_workspace.ts :: _build_service_map_md\n" +
    "  Regen:     sandbox init-workspace\n" +
    "  To change a service's type/port/path/deps, edit services.yaml and rerun.\n" +
    "  To change which services run locally for this feature, edit\n" +
    "  .sandbox/workspace.yml (services field) and rerun.\n" +
    "-->\n\n";

  const intro =
    "> Generated from `~/.sandbox/services.yaml`. " +
    "Maps service names to package paths within each repo. " +
    "**Mode** indicates whether the service runs locally for this feature " +
    "or falls through to a k8s port-forward (kept for completeness).\n\n";

  return header + "# Service Map\n\n" + intro + sections.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Log a warning/info message if CLAUDE.md already exists. */
function warnIfExisting(claudeMdPath: string): void {
  if (!fs.existsSync(claudeMdPath)) {
    return;
  }
  const existing = fs.readFileSync(claudeMdPath, "utf8");
  if (existing.includes("## Layout")) {
    warn("CLAUDE.md already initialised — overwriting with fresh content.");
  } else {
    info("Replacing stub CLAUDE.md with full workspace context.");
  }
}

const _LEGACY_HANDOFF_PLACEHOLDER = "*No handoff notes yet.*";

/** Rescue a filled-in legacy `## Handoff Notes` section into a note. */
function salvageLegacyHandoffNotes(workspaceRoot: string, claudeMdPath: string): void {
  if (!fs.existsSync(claudeMdPath)) {
    return;
  }
  try {
    const existing = fs.readFileSync(claudeMdPath, "utf8");
    const match = /^## Handoff Notes\n(?<body>[\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(existing);
    if (!match) {
      return;
    }
    const body = (match.groups!["body"] ?? "").trim();
    if (!body || body.includes(_LEGACY_HANDOFF_PLACEHOLDER)) {
      return;
    }

    const directory = notesDir(workspaceRoot);
    fs.mkdirSync(directory, { recursive: true });
    const filename = noteFilename(nextNoteNumber(directory), "contract", "migrated-handoff-notes");
    fs.writeFileSync(
      path.join(directory, filename),
      "---\n" +
        "type: contract\n" +
        "phase: implement\n" +
        "author: main\n" +
        "refs: []\n" +
        "status: open\n" +
        "---\n\n" +
        "Salvaged from the legacy CLAUDE.md `## Handoff Notes` section on regen.\n\n" +
        `${body}\n`,
    );
    success(`Salvaged legacy Handoff Notes → .sandbox/notes/${filename}`);
  } catch (exc) {
    warn(`Could not salvage legacy Handoff Notes: ${(exc as Error).message}`);
  }
}

/** Seed the workspace's first handoff note from creation-time inputs. */
function seedStartingHandoff(workspaceRoot: string, startingPrompt: string, workType: string): void {
  const prompt = startingPrompt.trim();
  const wt = workType.trim().toLowerCase();
  if (!prompt && !wt) {
    return;
  }
  const [phase, firstSkill] = WORK_TYPE_PHASES[wt] ?? ["research", "invoke `sb-research` first"];
  try {
    const directory = notesDir(workspaceRoot);
    const existing = listNotes(workspaceRoot, true);
    if (existing.some((note) => note.type === "handoff")) {
      return;
    }
    fs.mkdirSync(directory, { recursive: true });
    const filename = noteFilename(nextNoteNumber(directory), "handoff", "starting-prompt");
    const lines = [
      "---",
      "type: handoff",
      `phase: ${phase}`,
      "author: workspace-creation",
      "refs: []",
      "status: open",
      "---",
      "",
      "# Handoff: workspace creation",
      "",
    ];
    if (wt) {
      lines.push(`This workspace is a ${wt} — ${firstSkill}.`, "");
    }
    if (prompt) {
      lines.push(
        "Seeded from `starting_prompt` in .sandbox/workspace.yml when the",
        "workspace was created. The task below has not begun — confirm",
        "direction with the user before executing it.",
        "",
        prompt,
      );
    } else {
      lines.push("Seeded at workspace creation (no starting prompt was provided).");
    }
    fs.writeFileSync(path.join(directory, filename), lines.join("\n") + "\n");
    success(`Seeded starting handoff → .sandbox/notes/${filename}`);
  } catch (exc) {
    warn(`Could not seed starting handoff: ${(exc as Error).message}`);
  }
}

/** Log the resolved task title and any parsed workspace metadata. */
function logMeta(task: string, meta: Record<string, string>): void {
  info(`Task: ${task}`);
  for (const [key, label] of [
    ["FEATURE", "Feature"],
    ["SERVICES", "Services"],
    ["JIRA_ID", "Jira"],
    ["TEST_PATH", "Test path"],
  ] as Array<[string, string]>) {
    const value = meta[key];
    if (value) {
      info(`  ${(label + ":").padEnd(10)} ${value}`);
    }
  }
}

/** Execute `sandbox init-workspace`. */
export async function run(args: Record<string, unknown>): Promise<void> {
  // 0. Prompt-spec export — emit wizard definitions as JSON and exit without
  //    touching the workspace.
  if (args["print_prompts"]) {
    printPrompts(args);
    return;
  }

  if (args["print_form_schema"]) {
    printFormSchema(args);
    return;
  }

  // 1. Find workspace root
  let workspaceRoot: string;
  try {
    workspaceRoot = findWorkspaceRoot();
  } catch (exc) {
    if (exc instanceof WorkspaceRootError) {
      console.log(exc.message);
      process.exit(1);
    }
    throw exc;
  }

  const workspaceName = path.basename(workspaceRoot);
  info(`Workspace root: ${workspaceRoot}`);

  // 2. Resolve generic inputs from the config file (CLI flag > SANDBOX_* env >
  //    .sandbox/workspace.yml > existing .env).
  const inputs = resolveInputs(args, workspaceRoot);
  const hasConfig = hasWorkspaceConfig(workspaceRoot, (args["config_file"] as string | null) ?? null);
  if (!hasConfig && !inputs["feature"]) {
    error(
      "No .sandbox/workspace.yml found and no --feature given. " +
        "Run `sandbox workspace <name>` to create and initialise a workspace, " +
        "then rerun `sandbox init-workspace` from inside it to reconcile changes.",
    );
    process.exit(1);
  }

  // 2a. Persist resolved inputs to .sandbox/workspace.yml BEFORE writing any
  // other file — the durable source of truth. A no-op when unchanged.
  writeWorkspaceConfig(workspaceRoot, inputs);

  // 3. Reconcile repo worktrees against workspace.yml. Gated on `repos` being
  //    declared. Desired set = union(repos, repos owning `services`).
  if (inputs["repos"]) {
    const [servicesConfig] = loadSandboxServiceConfigs();
    const [desiredRepos, , unknown] = resolveRepos(inputs["repos"], inputs["services"], servicesConfig);
    if (unknown.length) {
      warn(`Unknown service(s) in workspace.yml (no owning repo): ${unknown.join(", ")}`);
    }
    reconcileWorktrees(workspaceRoot, desiredRepos, Boolean(args["force"]));
  }

  // 4. Check if CLAUDE.md already exists
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  warnIfExisting(claudeMdPath);

  // 5. Discover repos (reflecting the reconciled set)
  info("Scanning for git repos...");
  const repos = discoverRepos(workspaceRoot);
  if (!repos.length) {
    warn("No git repos found in workspace. CLAUDE.md will have an empty layout.");
  } else {
    for (const [name, branch] of repos) {
      info(`  ${name}/ → ${branch}`);
    }
    writeWorkspaceGitignore(workspaceRoot, repos.map(([name]) => name));
  }

  const [task, meta] = resolveTask(inputs["task"], workspaceName, workspaceRoot);

  // Resolved inputs win over anything the VK lookup populated.
  const _INPUT_TO_META: Record<string, string> = {
    feature: "FEATURE",
    services: "SERVICES",
    jira_id: "JIRA_ID",
    test_path: "TEST_PATH",
    description: "DESCRIPTION",
  };
  for (const [inputKey, metaKey] of Object.entries(_INPUT_TO_META)) {
    if (inputKey in inputs) {
      meta[metaKey] = inputs[inputKey];
    }
  }

  logMeta(task, meta);

  // 5. Generate .sandbox/service-map.md from services.yaml
  let hasServiceMap = false;
  if (repos.length) {
    const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
    if (Object.keys(servicesConfig).length) {
      const localServicesForMap = (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s);
      const serviceMapContent = buildServiceMapMd(repos, servicesConfig, reposConfig, localServicesForMap);
      if (serviceMapContent) {
        const sandboxDir = path.join(workspaceRoot, ".sandbox");
        fs.mkdirSync(sandboxDir, { recursive: true });
        fs.writeFileSync(path.join(sandboxDir, "service-map.md"), serviceMapContent);
        success("Wrote .sandbox/service-map.md");
        hasServiceMap = true;
      } else {
        info("No mapped services for discovered repos — skipping .sandbox/service-map.md");
      }
    }
  }

  // 5b. Resolve the workspace's active standards (docs/jit-context-system.md §4.1).
  let standardsSection: string | null = null;
  const modules = loadStandardsModules();
  if (Object.keys(modules).length) {
    const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
    for (const err of validateServiceStandards(servicesConfig, modules)) {
      warn(err);
    }
    const workspaceConfig = loadConfigFile(workspaceRoot, (args["config"] as string | null) ?? null);
    const repoNames = repos.map(([name]) => name);
    const localServices = (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s);
    const [active, notActive] = resolveActiveStandards(
      repoNames,
      servicesConfig,
      reposConfig,
      workspaceConfig,
      modules,
      localServices,
    );
    standardsSection = buildStandardsRoutingSection(active, notActive, modules, repoNames);
    info(`Standards routing: active = ${active.join(", ")}`);
    // PreToolUse standards gate manifest.
    writeStandardsManifest(workspaceRoot, buildStandardsManifest(active, modules));
  }

  // 6. Write CLAUDE.md. The notes directory is created; legacy free-text Handoff
  // Notes content is salvaged first, then the starting prompt / work type is
  // seeded as the first handoff note if the workspace has none yet.
  fs.mkdirSync(notesDir(workspaceRoot), { recursive: true });
  salvageLegacyHandoffNotes(workspaceRoot, claudeMdPath);
  seedStartingHandoff(workspaceRoot, inputs["starting_prompt"] ?? "", inputs["work_type"] ?? "");
  const content = buildClaudeMd(
    workspaceName,
    workspaceRoot,
    repos,
    task,
    meta,
    hasServiceMap,
    standardsSection,
  );
  fs.writeFileSync(claudeMdPath, content);
  success(`Wrote ${claudeMdPath}`);

  // 6a. Projected sb-* skills into .claude/skills/.
  for (const skillPath of writeWorkspaceSkills(workspaceRoot)) {
    success(`Wrote ${skillPath}`);
  }

  // 6b. Generated subagents: sb-researcher plus one sb-tester-<archetype> per
  // archetype present.
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const archetypes = loadArchetypes();
  const present = resolvePresentArchetypes(
    repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s),
    archetypes,
  );
  const testerSpecs = buildTesterSpecs(present, servicesConfig, archetypes);
  for (const agentPath of writeWorkspaceAgents(workspaceRoot, testerSpecs)) {
    success(`Wrote ${agentPath}`);
  }

  // 6c. SessionStart hook. Merges into settings.json, never clobbers.
  const hooksPath = writeWorkspaceHooks(workspaceRoot);
  success(`Wrote ${hooksPath}`);

  // 6d. MCP enablement: union the present archetypes' mcp_servers into .mcp.json.
  const mcpDefinitions = loadMcpServers();
  for (const err of validateArchetypeMcpServers(archetypes, mcpDefinitions)) {
    warn(err);
  }
  const mcpPath = writeWorkspaceMcp(workspaceRoot, resolveWorkspaceMcpServers(present, archetypes), mcpDefinitions);
  if (mcpPath) {
    success(`Wrote ${mcpPath}`);
  }

  // 6e. Plugin-version guard. Never blocks.
  for (const warning of pluginDriftWarnings()) {
    warn(warning);
  }

  // 7. Seed workspace metadata into .env.
  const envPath = path.join(workspaceRoot, ".env");
  fs.writeFileSync(
    envPath,
    Object.entries(meta)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
  success(`Wrote ${envPath}`);

  // 8. Generate docker-compose.yml, allocate slot, write .sandbox/sandbox-context.md
  const feature = (meta["FEATURE"] ?? "").trim();
  if (feature) {
    const slot = generateWorkspaceCompose(feature, meta["SERVICES"] ?? "", workspaceRoot);
    if (slot !== null) {
      // 9. Build images (without starting containers)
      info("Building Docker images (--no-start)...");
      const result = procRun(["docker", "compose", "up", "--build", "--no-start"], {
        cwd: workspaceRoot,
        stdio: "inherit",
      });
      if (result.status === 0) {
        success("Docker images built successfully.");
      } else {
        warn("docker compose build exited non-zero — images may be incomplete.");
      }
    }
  }

  console.log(
    `\n${Colors.BOLD}Workspace initialised.${Colors.RESET} ` +
      "Open a new Claude Code session from the workspace root to pick up the context:\n\n" +
      `    ${claudeSessionCommand(workspaceRoot)}\n`,
  );
}
