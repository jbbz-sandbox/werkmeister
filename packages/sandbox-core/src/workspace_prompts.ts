/**
 * The workspace prompt-spec chain: input resolution, the wizard's prompt
 * definitions, and their serialisation to the prompt-spec JSON the form is built from.
 *
 * This lives in core because both drivers need it in-process. The CLI renders
 * these prompts in a terminal wizard (`runWizard` — rendering stays CLI-side)
 * and the dashboard/extension turn the same spec into an RJSF form via
 * {@link buildFormSchema}. Core used to reach the second path by spawning
 * `sandbox workspace --print-form-schema`, which made core depend on the CLI
 * that depends on core — see note 087, `core never drives the CLI`.
 *
 * Moved verbatim from `apps/cli/src/commands/init_workspace.ts` and
 * `workspace.ts`; the CLI imports every name it still uses back from here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as YAML from "yaml";

import { COMPOSE_FILE } from "./compose_file.js";
import { loadReposConfig, loadServices, type ReposConfig, type ServicesConfig } from "./config.js";
import type { PromptEntry, PromptSpecJson } from "./form_schema.js";
import type { PromptSpec } from "./global_config.js";
import { issueIdOf, issueTracker } from "./issue_tracker.js";
import { ProcError, run as procRun } from "./proc.js";
import { info, warn } from "./reporter.js";
import { STRATEGY_IDS } from "./strategies/types.js";

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
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
export function loadWorkspaceConfig(p: string): unknown {
  const text = fs.readFileSync(p, "utf8");
  const suffix = path.extname(p);
  if (suffix === ".yaml" || suffix === ".yml") {
    return YAML.parse(text);
  }
  return JSON.parse(stripJsoncComments(text));
}

// Keys are [cliAttr, envVar, configField], consulted in order CLI > env > config.
// `feature` has no env source: every workspace container exports SANDBOX_FEATURE
// as its own identity, which would prefill any workspace created from inside one (#148).
export const _INPUT_FIELDS: ReadonlyArray<[string, string | null, string]> = [
  ["feature", null, "feature"],
  ["work_type", "SANDBOX_WORK_TYPE", "work_type"],
  ["context_strategy", "SANDBOX_CONTEXT_STRATEGY", "context_strategy"],
  ["repos", "SANDBOX_REPOS", "repos"],
  ["services", "SANDBOX_SERVICES", "services"],
  ["issue_id", "SANDBOX_ISSUE_ID", "issue_id"],
  ["test_path", "SANDBOX_TEST_PATH", "test_path"],
  ["description", "SANDBOX_DESCRIPTION", "description"],
  ["task", "SANDBOX_TASK", "task"],
  ["starting_prompt", "SANDBOX_STARTING_PROMPT", "starting_prompt"],
  ["labels", "SANDBOX_LABELS", "labels"],
  ["autonomous", "SANDBOX_AUTONOMOUS", "autonomous"],
];

/** A truthy flag value as it arrives from a CLI switch, an env var, YAML or a form. */
export function isTrue(value: unknown): boolean {
  return /^(true|1|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * The workspace's `autonomous` input. Reads the config itself rather than
 * through `loadConfigFile`, which logs — the same reason as `readContextStrategy`.
 */
export function readAutonomous(workspaceRoot: string): boolean {
  const envOverride = process.env["SANDBOX_WORKSPACE_CONFIG"];
  const candidates = [
    ...(envOverride ? [expandUserPath(envOverride)] : []),
    ..._WORKSPACE_CONFIG_NAMES.map((name) => path.join(workspaceRoot, ".sandbox", name)),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      return isTrue((loadWorkspaceConfig(p) as Record<string, unknown> | null)?.["autonomous"]);
    } catch {
      return false;
    }
  }
  return false;
}

// Workspace config filenames in search-order precedence: preferred YAML first,
// then legacy JSONC/JSON kept readable for back-compat. workspace.yml is also
// the canonical write target (the rest are migrated to it on the next write).
export const _WORKSPACE_CONFIG_NAMES = [
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
export function loadConfigFile(
  workspaceRoot: string,
  override: string | null,
): Record<string, unknown> {
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
    let data: unknown;
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
    return data as Record<string, unknown>;
  }

  return {};
}

/** Expand a leading `~` (no cwd resolution). */
export function expandUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
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
  // Pre-rename .env keys; a later ISSUE_ID line still wins.
  wanted["JIRA_ID"] = wanted["GITHUB_ISSUE"] = "issue_id";
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
export function resolveInputs(
  args: Record<string, unknown>,
  workspaceRoot: string,
): Record<string, string> {
  const configData = loadConfigFile(workspaceRoot, (args["config_file"] as string | null) ?? null);
  const existingEnv = loadExistingEnvMetadata(workspaceRoot);
  const resolved: Record<string, string> = {};

  for (const [cliAttr, envVar, configField] of _INPUT_FIELDS) {
    const cliValue = args[cliAttr] ?? null;
    const envValue = envVar ? (process.env[envVar] ?? null) : null;
    // Workspaces made before the rename hold `jira_id` / `github_issue`: read, never written.
    const cfgValue =
      configField === "issue_id"
        ? issueIdOf(configData) || null
        : configField in configData
          ? configData[configField]
          : null;
    const envFileValue = configField in existingEnv ? existingEnv[configField] : null;
    for (const source of [cliValue, envValue, cfgValue, envFileValue]) {
      if (source === null || source === undefined) {
        continue;
      }
      // A multi-value field may arrive from YAML as a list; downstream expects a
      // comma-separated string, so join rather than stringifying the list.
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
  if (resolved.issue_id)
    resolved.issue_id = issueTracker().parseRef(resolved.issue_id) ?? resolved.issue_id;
  if (resolved.autonomous) resolved.autonomous = String(isTrue(resolved.autonomous));

  return resolved;
}

/** Derive a kebab-case feature default from the workspace dir name. */
function defaultFeatureFromDir(workspaceName: string): string {
  let parts = workspaceName.split("-");
  if (
    parts.length &&
    parts[0].length === 4 &&
    [...parts[0].toLowerCase()].every((c) => "0123456789abcdef".includes(c))
  ) {
    parts = parts.slice(1);
  }
  return parts.length ? parts.join("-") : workspaceName;
}

/** Best-effort: scan each immediate-child repo's branch for an issue ref the tracker recognises. */
function scrapeIssueId(workspaceRoot: string): string {
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
    const ref = issueTracker().parseRef(result.stdout.trim());
    if (ref) {
      return ref;
    }
  }
  return "";
}

export type Phase = "research" | "implement" | "test" | "review" | "pr";
export type PhasePath = "spike" | "bounded" | "architectural";

/** What must exist in .sandbox/notes/ before the first source edit. */
export interface PhaseGate {
  note: "decision" | "finding";
  status?: "decided"; // absent = any non-superseded note of that type
}

export interface WorkTypePlan {
  path: PhasePath;
  phases: Phase[]; // rendered in this order
  gate: PhaseGate | null; // null = no phase gate (standards gate still applies)
  hint: string; // one sentence for the seeded handoff
}

// Work type → the JIT phases, the first phase's exit artifact, and the gate
// that artifact satisfies (docs/jit-context-system.md §5.3, §6).
export const WORK_TYPE_PHASES: Record<string, WorkTypePlan> = {
  feature: {
    path: "architectural",
    phases: ["research", "implement", "test", "review", "pr"],
    gate: { note: "decision", status: "decided" },
    hint: "invoke `sb-research` first — it ends in a `decision` note the user approves before any code",
  },
  bugfix: {
    path: "bounded",
    phases: ["research", "implement", "test", "pr"],
    gate: { note: "finding" },
    hint: "invoke `sb-research` first to reproduce and write the root cause to a `finding` note before changing code",
  },
  incident: {
    path: "bounded",
    phases: ["research", "implement", "test", "pr"],
    gate: { note: "finding" },
    hint: "invoke `sb-research` first to diagnose; the `finding` note is the incident record",
  },
  refactor: {
    path: "bounded",
    phases: ["implement", "test", "review", "pr"],
    gate: null,
    hint: "invoke `sb-implement` first — the scope is known and standards matter most",
  },
  spike: {
    path: "spike",
    phases: ["research"],
    gate: null,
    hint: "invoke `sb-research` first to frame the questions; anything built is throwaway and there is no PR",
  },
};

export const DEFAULT_PLAN: WorkTypePlan = {
  path: "architectural",
  phases: ["research", "implement", "test", "review", "pr"],
  gate: null,
  hint: "invoke `sb-research` first",
};

/** The plan for a free-text work type; unknown (or "Other") → {@link DEFAULT_PLAN}. */
export function planFor(workType: string): WorkTypePlan {
  const key = workType.trim().toLowerCase();
  return Object.hasOwn(WORK_TYPE_PHASES, key) ? WORK_TYPE_PHASES[key] : DEFAULT_PLAN;
}
const WORK_TYPES: string[] = Object.keys(WORK_TYPE_PHASES);

export const _WIZARD_PROMPTS: readonly PromptSpec[] = [
  {
    // Label, pattern and placeholder come from the configured tracker: see wizardPrompts().
    key: "issue_id",
    label: "Issue ID (blank to skip)",
    help:
      "Issue ID in this machine's issue tracker. The issue is fetched and stored in " +
      "the workspace; empty fields are filled from it.",
    defaultFn: (ws) => scrapeIssueId(ws),
  },
  {
    key: "feature",
    label: "Feature name (lowercase, hyphen-separated)",
    help:
      "Drives sandbox slot routing via the X-Feature cookie. " +
      `No feature = no ${COMPOSE_FILE} / sandbox-context.md.`,
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
      "What kind of work this is; selects the phase sequence and the " +
      "pre-implementation gate in CLAUDE.md.",
    acceptEmpty: false,
    pattern: "^(" + Object.keys(WORK_TYPE_PHASES).join("|") + ")$",
    defaultFn: () => "feature",
    choicesFn: () => [...WORK_TYPES],
  },
  {
    key: "context_strategy",
    label: "Context strategy",
    help:
      "Which context layer init-workspace generates: jit (sb-* skills, hooks, notes) " +
      "or icm (staged folders the agent walks by itself). Default icm.",
    pattern: "^(" + STRATEGY_IDS.join("|") + ")$",
    defaultFn: () => STRATEGY_IDS[0],
    choicesFn: () => [...STRATEGY_IDS],
  },
  {
    key: "autonomous",
    label: "Autonomous run",
    help:
      "Off by default. On: an icm run goes from stage 01 to `sandbox pr open` with no human check " +
      "(each stage self-checks and the agent approves its own PR file), and .claude/settings.json " +
      "allows the git, sandbox, docker, gh, node and python3 calls a headless session needs. " +
      "The person reviews the PR; `sandbox pr gate` still applies.",
    boolean: true,
  },
  {
    key: "services",
    label: "Local services (comma-separated, blank = none)",
    help: "Services to run locally with hot-reload; the rest fall through to k8s port-forwards.",
    multi: true,
    choicesFn: () => Object.keys(loadSandboxServiceConfigs()[0]).sort(),
    choiceGroupsFn: () =>
      Object.fromEntries(
        Object.entries(loadSandboxServiceConfigs()[0]).map(([name, svc]) => [
          name,
          String(svc?.repo ?? "other"),
        ]),
      ),
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

export interface PromptSpecOptions {
  /**
   * `false` skips every prompt's `defaultFn`. The issue default scans
   * *workspaceRoot*'s subdirectories with `git`, so a caller that discards
   * defaults anyway (the create form, built against `$HOME`) opts out.
   */
  defaults?: boolean;
}

/** Serialise one PromptSpec to a JSON-ready entry, resolved against the workspace. */
export function promptEntry(
  spec: PromptSpec,
  workspaceRoot: string,
  resolved: Record<string, string>,
  opts: PromptSpecOptions = {},
): PromptEntry {
  const entry: PromptEntry = {
    key: spec.key,
    label: spec.label,
    help: spec.help,
    accept_empty: spec.acceptEmpty ?? true,
    multi: spec.multi ?? false,
    recommended: spec.recommended ?? false,
    default: spec.defaultFn && opts.defaults !== false ? spec.defaultFn(workspaceRoot) : "",
    resolved: spec.key in resolved,
    resolved_value: spec.key in resolved ? resolved[spec.key] : null,
  };
  if (spec.multiline) {
    entry["multiline"] = true;
  }
  if (spec.boolean) {
    entry["boolean"] = true;
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
  if (spec.choiceGroupsFn) {
    // choice → group inverted to group → choices, groups sorted by name.
    const groups: Record<string, string[]> = {};
    const byChoice = spec.choiceGroupsFn();
    for (const choice of entry["choices"] ?? Object.keys(byChoice)) {
      (groups[byChoice[choice] ?? "other"] ??= []).push(choice);
    }
    entry["choice_groups"] = Object.fromEntries(
      Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return entry;
}

/** `_WIZARD_PROMPTS` with the issue prompt worded and validated for the configured tracker. */
export function wizardPrompts(): PromptSpec[] {
  const tracker = issueTracker();
  return _WIZARD_PROMPTS.map((spec) =>
    spec.key === "issue_id"
      ? {
          ...spec,
          label: `${tracker.label} issue (blank to skip)`,
          placeholder: tracker.refExample,
          ...(tracker.refPattern ? { pattern: tracker.refPattern } : {}),
        }
      : spec,
  );
}

/** Serialise {@link wizardPrompts} to JSON-ready data for external drivers. */
export function buildPromptSpec(
  workspaceRoot: string,
  resolved: Record<string, string>,
  opts: PromptSpecOptions = {},
): PromptSpecJson {
  return {
    workspace_root: workspaceRoot,
    workspace_name: path.basename(workspaceRoot),
    prompts: wizardPrompts().map((spec) => promptEntry(spec, workspaceRoot, resolved, opts)),
  };
}

/** Convert a workspace dir name into a human-readable task hint. */
export function slugToTask(workspaceName: string): string {
  let parts = workspaceName.split("-");
  if (
    parts.length &&
    parts[0].length === 4 &&
    [...parts[0].toLowerCase()].every((c) => "0123456789abcdef".includes(c))
  ) {
    parts = parts.slice(1);
  }
  return parts.length
    ? parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ")
    : workspaceName;
}

/** Load services and repos config from services.yaml. Both may be empty. */
export function loadSandboxServiceConfigs(): [ServicesConfig, ReposConfig] {
  try {
    return [loadServices(), loadReposConfig()];
  } catch {
    return [{}, {}];
  }
}

// ---------------------------------------------------------------------------
// The full spec (wizard prompts + `repos`)
// ---------------------------------------------------------------------------

/**
 * `repos` is a workspace-creation prompt, not an init-workspace one, so it is
 * not in `_WIZARD_PROMPTS`; the terminal wizard and the browser form both splice this one spec in after `services`.
 */
export const REPOS_PROMPT: PromptSpec = {
  key: "repos",
  label: "Additional repos (optional)",
  help:
    "Extra repos to create worktrees for. The final set is the union of " +
    "these and the repos owning the services selected above.",
  multi: true,
  choicesFn: () => Object.keys(loadReposConfig()).sort(),
};

/**
 * Resolve inputs and build the prompt spec `sandbox workspace` presents:
 * `_WIZARD_PROMPTS` with {@link REPOS_PROMPT} spliced in after `services`.
 *
 * Callers that print the result as JSON on stdout must silence stdout
 * diagnostics themselves — `loadConfigFile` reports through the ambient
 * reporter.
 */
export function computePromptSpec(
  args: Record<string, unknown>,
  workspaceRoot: string,
  opts: PromptSpecOptions = {},
): PromptSpecJson {
  return workspacePromptSpec(workspaceRoot, resolveInputs(args, workspaceRoot), opts);
}

/** {@link computePromptSpec} for inputs the caller has already resolved. */
export function workspacePromptSpec(
  workspaceRoot: string,
  resolved: Record<string, string>,
  opts: PromptSpecOptions = {},
): PromptSpecJson {
  const spec = buildPromptSpec(workspaceRoot, resolved, opts);

  // workspaceRoot is only consulted for a spec's defaultFn; REPOS_PROMPT has
  // none, so the value passed here is irrelevant.
  const reposEntry = promptEntry(REPOS_PROMPT, "", resolved);
  if ((reposEntry.choices as string[]).length) {
    const prompts = spec.prompts ?? [];
    let servicesIdx = prompts.findIndex((p) => p.key === "services");
    if (servicesIdx === -1) {
      servicesIdx = prompts.length - 1;
    }
    prompts.splice(servicesIdx + 1, 0, reposEntry);
    spec.prompts = prompts;
  }
  return spec;
}
