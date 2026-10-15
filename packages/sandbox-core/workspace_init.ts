/**
 * Workspace creation and reconciliation — the work behind `sandbox workspace`
 * and `sandbox init-workspace`.
 *
 * Moved here from `apps/cli/src/commands/workspace.ts` and
 * `.../init_workspace.ts` (note 086 row 5) so `createWorkspace` can call it
 * instead of spawning the CLI that depends on this package (note 087). The two
 * commands are now argv adapters: they parse flags, run the interactive wizard,
 * print the prompt-spec JSON, and translate a failure into an exit code.
 *
 * Two entry points, in the order the CLI runs them:
 *
 *   {@link provisionWorkspace} — create the workspace ROOT (a worktree of the
 *   `sandbox-workspace` repo on `<user>/<workspace>`), write
 *   `.sandbox/workspace.yml`, hand off to `initWorkspace`, and commit.
 *
 *   {@link initWorkspace} — reconcile the nested per-repo worktrees against
 *   that config and (re)generate CLAUDE.md, .env, docker-compose.yml, the
 *   projected .claude/ skills+agents, .mcp.json and .sandbox/*. Idempotent.
 *
 * Nothing here prints or exits: every message goes through the ambient reporter
 * and every fatal path throws {@link WorkspaceInitError} *after* its `[err]`
 * line has been emitted, so the CLI exits 1 without printing it twice and an
 * in-process caller survives (note 070 §3).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as YAML from "yaml";

import { presentArchetypes } from "./archetypes.js";
import { Colors } from "./colors.js";
import { expandUser, getReposRoot, loadArchetypes, loadMcpServers, loadServices } from "./config.js";
import { SandboxError } from "./errors.js";
import { generateWorkspaceCompose, seedWorkspaceMetadataEnv } from "./generate.js";
import { loadPaths } from "./global_config.js";
import { issueTracker } from "./issue_tracker.js";
import { IssueFetchError, fetchIssueSnapshot, readIssueRef, writeIssueCopy, type IssueSnapshot } from "./issue_snapshot.js";
import { WORKSPACE_ROOT_REPO } from "./machine_setup.js";
import {
  resolveWorkspaceMcpServers,
  validateArchetypeMcpServers,
  writeWorkspaceMcp,
} from "./mcp_gen.js";
import { pluginDriftWarnings } from "./plugin_check.js";
import { run as procRun } from "./proc.js";
import { error, info, passthrough, raw, success, warn } from "./reporter.js";
import { repoDirs } from "./standards.js";
import type { IssueRef } from "./strategies/types.js";
import { STRATEGY_IDS, parseStrategyId, reportLeftovers, strategyById } from "./strategies/index.js";
import {
  _INPUT_FIELDS,
  _WORKSPACE_CONFIG_NAMES,
  expandUserPath,
  loadSandboxServiceConfigs,
  loadWorkspaceConfig,
  resolveInputs,
  slugToTask,
} from "./workspace_prompts.js";
import {
  createWorktree,
  removeWorktree,
  resolveRepos,
  worktreeIsDirty,
  writeWorkspaceGitignore,
} from "./worktrees.js";

/**
 * A fatal path whose `[err] …` line has already gone through the reporter.
 *
 * It replaces the `error(msg); process.exit(1)` pairs this code ended on when
 * it was a CLI command — a library cannot end the process, and re-throwing a
 * plain `SandboxError` would make `main.ts`'s handler print the same line
 * again. The two argv adapters catch it and exit 1 in silence.
 */
export class WorkspaceInitError extends SandboxError {
  constructor(message: string) {
    super(message, "WORKSPACE_INIT");
    this.name = "WorkspaceInitError";
  }
}

/** Emit the `[err]` line, then abort the run. */
function fail(message: string): never {
  error(message);
  throw new WorkspaceInitError(message);
}


/** Caller-supplied affordances that a library cannot assume for itself. */
export interface InitWorkspaceOptions {
  /**
   * Read a task title piped on stdin, used only when no `--task` / config value
   * resolved. The CLI passes a reader; in-process callers leave it unset so fd 0
   * — which may be an MCP transport — is never touched.
   */
  readStdinTask?: () => string;
  /**
   * Discard rather than abort: repo worktrees dropped from workspace.yml go
   * even when dirty, and a `<user>/<workspace>` branch already on origin is
   * deleted instead of blocking creation.
   */
  force?: boolean;
  /** The snapshot createWorkspace fetched; written to .sandbox/issue.md before the strategy runs. */
  issue?: IssueSnapshot;
}

/**
 * Write the issue copy when one is handed over or a refresh is asked for, then
 * return what the strategy renders. A failed refresh throws before writing, so
 * the old copy survives.
 */
export async function resolveIssueCopy(
  root: string,
  issueId: string,
  opts: { issue?: IssueSnapshot; refresh?: boolean },
): Promise<IssueRef | null> {
  if (opts.issue) {
    writeIssueCopy(root, opts.issue);
  } else if (opts.refresh) {
    if (!issueId) throw new WorkspaceInitError("--refresh-issue: this workspace has no issue_id.");
    try {
      writeIssueCopy(root, await fetchIssueSnapshot(issueId));
    } catch (e) {
      if (e instanceof IssueFetchError) throw new WorkspaceInitError(`${e.message}; run \`sandbox connect\` to check the issue tracker.`);
      throw e;
    }
  }
  return readIssueRef(root, issueId);
}
/** Thrown by {@link findWorkspaceRoot}; the CLI's print paths and
 *  `init-workspace` adapter catch it and print the (pre-rendered) message. */
export class WorkspaceRootError extends Error {}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Current username: env-driven, with an os.userInfo() fallback. */
function getuser(): string {
  for (const name of ["LOGNAME", "USER", "LNAME", "USERNAME"]) {
    const v = process.env[name];
    if (v) return v;
  }
  return os.userInfo().username;
}
// ---------------------------------------------------------------------------
// Input resolution (CLI flag > env var > config file > default).
// ---------------------------------------------------------------------------

// Config fields persisted as a real YAML list rather than a comma-joined string.
const _LIST_VALUED_FIELDS = new Set<string>(["labels"]);

/** Comma-separated string -> trimmed, non-empty list items. */
function splitMultiValue(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s);
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

// No schema modeline or `$schema` key: the repo is private, so a GitHub URL
// 404s in the editor, and either one outranks the local `yaml.schemas`
// mapping `sandbox setup` writes (machine_setup.ts :: syncEditorSchemas).
const _WORKSPACE_CONFIG_HEADER =
  "# AUTO-GENERATED — durable source of truth for workspace inputs.\n" +
  "# Tool:    sandbox init-workspace\n" +
  "# Source:  src/commands/init_workspace.ts :: _write_workspace_config\n" +
  "# Edit:    Hand-edit `feature`, `repos`, `services`, `issue_id`, `task`,\n" +
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
 * Keys are sorted and multi-line strings are block-styled, so a rerun that
 * changes nothing produces a byte-identical file.
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
  // Drop the legacy `_generator` key — its job is now done by the header comment —
  // and the old `$schema` URL (see _WORKSPACE_CONFIG_HEADER).
  delete existing["_generator"];
  delete existing["$schema"];
  const merged: Record<string, any> = { ...existing };
  for (const [, , field] of _INPUT_FIELDS) {
    if (field in resolved) {
      let value: string | string[] | boolean = resolved[field];
      if (_LIST_VALUED_FIELDS.has(field) && typeof value === "string") {
        value = splitMultiValue(value);
      }
      // A real YAML boolean, so workspace.schema.json's `type: boolean` holds.
      if (field === "autonomous") value = value === "true";
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

// A workspace directory / feature slug: lowercase, hyphen-separated.
const _SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `<issue slug>-<feature>`, or the feature alone. `issueSlug` is the tracker's slug of the ref. */
export function buildWorkspaceName(feature: string, issueSlug: string | null): string {
  const featureSlug = (feature || "").trim().toLowerCase();
  const prefix = (issueSlug || "").trim().toLowerCase();
  return prefix ? `${prefix}-${featureSlug}` : featureSlug;
}

export function buildBranchName(username: string, workspaceName: string): string {
  return `${username}/${workspaceName}`;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveReposRoot(): string {
  return getReposRoot();
}

function resolveWorkspacesRoot(): string {
  const configured = loadPaths()["workspaces_root"];
  if (configured) {
    return path.resolve(expandUser(configured));
  }
  return path.resolve(path.join(os.homedir(), "workspace"));
}

// ---------------------------------------------------------------------------
// Git worktree creation
// ---------------------------------------------------------------------------

function createWorkspaceRoot(workspaceDir: string, branch: string, force: boolean): void {
  const reposRoot = resolveReposRoot();
  const rootRepoSrc = path.join(reposRoot, WORKSPACE_ROOT_REPO);

  info(`Workspace:  ${workspaceDir}`);
  info(`Branch:     ${branch}`);

  if (fs.existsSync(path.join(rootRepoSrc, ".git"))) {
    try {
      createWorktree(rootRepoSrc, workspaceDir, branch, { force });
    } catch (exc) {
      fail(`Failed to create workspace root worktree: ${(exc as Error).message}`);
    }
    success(`Created workspace root (worktree of ${WORKSPACE_ROOT_REPO}) at ${workspaceDir}`);
  } else {
    warn(
      `No '${WORKSPACE_ROOT_REPO}' repo at ${rootRepoSrc} — workspace root ` +
        "will be a plain directory (no git history for notes/config).",
    );
    // ponytail: parents=True; caller has already verified the dir doesn't exist.
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
}

function commitWorkspaceState(workspaceDir: string, workspaceName: string): void {
  if (!fs.existsSync(path.join(workspaceDir, ".git"))) {
    return;
  }
  try {
    procRun(["git", "-C", workspaceDir, "add", "-A"], { capture: true, check: true });
    const staged = procRun(
      ["git", "-C", workspaceDir, "diff", "--cached", "--quiet"],
      { capture: true },
    );
    if (staged.status === 0) {
      return; // nothing to commit
    }
    procRun(
      ["git", "-C", workspaceDir, "commit", "-q", "-m", `chore: initialize workspace ${workspaceName}`],
      { capture: true, check: true },
    );
    success("Committed initial workspace state (branch not pushed — push when ready).");
  } catch (exc) {
    warn(`Could not commit initial workspace state: ${(exc as Error).message}`);
  }
}
async function selectRepos(
  reposValue: string | null | undefined,
  servicesValue: string | null | undefined,
): Promise<string[]> {
  const servicesConfig = loadServices();
  // `reposValue` already reflects CLI/env/config *and* any wizard answer (both
  // land in the resolved inputs), so repos chosen interactively take effect.
  const [resolvedRepos, , unknown] = resolveRepos(
    reposValue ?? null,
    servicesValue ?? null,
    servicesConfig,
  );
  if (unknown.length) {
    fail(
      `Unknown service(s): ${unknown.join(", ")}. ` +
        "See `sandbox services` / config/services.yaml.",
    );
  }

  if (!resolvedRepos.length) {
    // On a TTY the wizard already offered services + repos; a non-TTY run had
    // only flags/config. Either way, nothing selected means nothing to create.
    fail(
      "No repos selected. Choose at least one service or repo in the wizard, " +
        "or pass --services svc1,svc2 / --repos r1,r2.",
    );
  }

  return resolvedRepos;
}
// ---------------------------------------------------------------------------
// Workspace detection
// ---------------------------------------------------------------------------

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
export function findWorkspaceRoot(): string {
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
export function discoverRepos(workspaceRoot: string): Array<[string, string]> {
  return repoDirs(workspaceRoot).map((d) => [path.basename(d), getBranch(d)]);
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
    fail(
      `Source repo(s) not found under ${reposRoot}: ${missingSrc.join(", ")}. ` +
        "Clone them there (or fix `repos` in .sandbox/workspace.yml) and rerun.",
    );
  }

  // Pre-flight: a dirty removal aborts the whole run without changes.
  if (toRemove.length && !force) {
    const dirty = toRemove.filter((r) => worktreeIsDirty(path.join(workspaceRoot, r)));
    if (dirty.length) {
      fail(
        `Refusing to remove worktree(s) with uncommitted changes: ${dirty.join(", ")}. ` +
          "Commit or stash them, or rerun with --force to discard them.",
      );
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
      fail(`Could not remove worktree '${repo}': ${message}`);
    }
  }

  const created: Array<[string, string]> = []; // [dest, src]
  try {
    for (const repo of toCreate) {
      const src = path.join(reposRoot, repo);
      const dest = path.join(workspaceRoot, repo);
      createWorktree(src, dest, branch, { force });
      created.push([dest, src]);
    }
  } catch (exc) {
    const message = `Failed to create worktree: ${(exc as Error).message}`;
    error(message);
    warn("Rolling back worktrees created this run...");
    for (const [dest, src] of [...created].reverse()) {
      removeWorktree(src, dest, branch);
    }
    // Not `fail()`: the rollback's own warnings belong between the `[err]` line
    // and the abort, exactly as they printed before.
    throw new WorkspaceInitError(message);
  }

  if (toCreate.length || toRemove.length) {
    success(`Worktrees reconciled (+${toCreate.length} / -${toRemove.length}).`);
  }
}

// ---------------------------------------------------------------------------
// Task description helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the task title: `--task` > the caller's stdin reader > a hint derived
 * from the workspace slug.
 *
 * Reading fd 0 is the CLI's affordance (`echo "…" | sandbox init-workspace`),
 * so only the CLI supplies a reader. In-process fd 0 belongs to the host — for
 * `sandbox dashboard` it is the JSON-RPC channel — and must not be read.
 */
function resolveTask(
  argsTask: string | null | undefined,
  workspaceName: string,
  readStdinTask?: () => string,
): [string, Record<string, string>] {
  if (argsTask) {
    return [argsTask.trim(), {}];
  }

  const piped = readStdinTask?.().trim();
  if (piped) {
    return [piped, {}];
  }

  return [slugToTask(workspaceName), {}];
}

// ---------------------------------------------------------------------------
// Sandbox config loading
// ---------------------------------------------------------------------------

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

/** Log the resolved task title and any parsed workspace metadata. */
function logMeta(task: string, meta: Record<string, string>): void {
  info(`Task: ${task}`);
  for (const [key, label] of [
    ["FEATURE", "Feature"],
    ["SERVICES", "Services"],
    ["ISSUE_ID", "Issue"],
    ["TEST_PATH", "Test path"],
  ] as Array<[string, string]>) {
    const value = meta[key];
    if (value) {
      info(`  ${(label + ":").padEnd(10)} ${value}`);
    }
  }
}

/**
 * Execute `sandbox init-workspace`.
 *
 * `workspaceRootOverride` is how `sandbox workspace` hands over the directory it
 * just created: everything below resolves paths from the root rather than the
 * cwd, so with it supplied this runs in-process instead of `workspace` having to
 * re-exec the CLI in the new directory just to move `findWorkspaceRoot`'s
 * starting point.
 */
export async function initWorkspace(
  args: Record<string, unknown>,
  workspaceRootOverride?: string,
  opts: InitWorkspaceOptions = {},
): Promise<void> {
  // 1. Find workspace root. A WorkspaceRootError propagates: printing its
  //    (already rendered) message and choosing an exit status is the CLI's job.
  const workspaceRoot = workspaceRootOverride ?? findWorkspaceRoot();

  const workspaceName = path.basename(workspaceRoot);
  info(`Workspace root: ${workspaceRoot}`);

  // 2. Resolve generic inputs from the config file (CLI flag > SANDBOX_* env >
  //    .sandbox/workspace.yml > existing .env).
  const inputs = resolveInputs(args, workspaceRoot);
  // The layer this run writes, validated before 2a persists it.
  const strategy = strategyById(parseStrategyId(inputs["context_strategy"]));
  const hasConfig = hasWorkspaceConfig(workspaceRoot, (args["config_file"] as string | null) ?? null);
  if (!hasConfig && !inputs["feature"]) {
    fail(
      "No .sandbox/workspace.yml found and no --feature given. " +
        "Run `sandbox workspace <name>` to create and initialise a workspace, " +
        "then rerun `sandbox init-workspace` from inside it to reconcile changes.",
    );
  }

  // 2a. Persist resolved inputs to .sandbox/workspace.yml BEFORE writing any
  // other file — the durable source of truth. A no-op when unchanged.
  writeWorkspaceConfig(workspaceRoot, inputs);

  // 2b. The issue copy (.sandbox/issue.md): handed over at creation, refreshed on request, else read back.
  const issueId = inputs["issue_id"] ? (issueTracker().parseRef(inputs["issue_id"]) ?? inputs["issue_id"]) : "";
  let issue: IssueRef | null;
  try {
    issue = await resolveIssueCopy(workspaceRoot, issueId, { issue: opts.issue, refresh: Boolean(args["refresh_issue"]) });
  } catch (e) {
    if (e instanceof WorkspaceInitError) fail(e.message);
    throw e;
  }

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

  const [task, meta] = resolveTask(inputs["task"], workspaceName, opts.readStdinTask);

  // Resolved inputs win over anything the VK lookup populated.
  const _INPUT_TO_META: Record<string, string> = {
    feature: "FEATURE",
    services: "SERVICES",
    issue_id: "ISSUE_ID",
    test_path: "TEST_PATH",
    description: "DESCRIPTION",
  };
  for (const [inputKey, metaKey] of Object.entries(_INPUT_TO_META)) {
    if (inputKey in inputs) {
      meta[metaKey] = inputs[inputKey];
    }
  }

  logMeta(task, meta);

  // 5b–6c. The context layer — CLAUDE.md and everything the agent reads
  // beside it — belongs to the workspace's strategy (docs/context-strategies.md).
  strategy.init({
    workspaceRoot,
    workspaceName,
    repos,
    task,
    meta,
    inputs,
    configOverride: (args["config"] as string | null) ?? null,
    issue,
    isCreate: Boolean(opts.issue),
  });

  // The config field read at the top of this run is already the new value when
  // the user just edited workspace.yml — there is no reliable "previous
  // strategy" to compare against. Instead, check every OTHER registered
  // strategy for paths it left behind that the active one does not also own.
  for (const id of STRATEGY_IDS) {
    if (id === strategy.id) continue;
    reportLeftovers(workspaceRoot, strategyById(id), strategy, Boolean(args["prune_context"]));
  }

  // 6d needs the present archetypes whichever strategy ran.
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const archetypes = loadArchetypes();
  const present = presentArchetypes(repos, meta, servicesConfig, reposConfig, archetypes);

  // 6d. MCP enablement: union the present archetypes' mcp_servers into .mcp.json.
  const mcpDefinitions = loadMcpServers();
  for (const err of validateArchetypeMcpServers(archetypes, mcpDefinitions)) {
    warn(err);
  }
  // Only when non-empty: substituting "" would write an X-Sandbox-Feature header
  // that silently resolves to no feature, where a literal `${FEATURE}` left in
  // the file makes the misconfiguration visible.
  const mcpFeature = (meta["FEATURE"] ?? "").trim();
  const mcpPath = writeWorkspaceMcp(
    workspaceRoot,
    resolveWorkspaceMcpServers(present, archetypes),
    mcpDefinitions,
    mcpFeature ? { FEATURE: mcpFeature } : {},
  );
  if (mcpPath) {
    success(`Wrote ${mcpPath}`);
  }

  // 6e. Plugin-version guard. Never blocks.
  for (const warning of pluginDriftWarnings()) {
    warn(warning);
  }

  // 7. Seed workspace metadata into .env.
  const envPath = path.join(workspaceRoot, ".env");
  seedWorkspaceMetadataEnv(envPath, meta);
  success(`Wrote ${envPath}`);

  // 8. Generate docker-compose.yml, allocate slot, write .sandbox/sandbox-context.md
  const feature = (meta["FEATURE"] ?? "").trim();
  if (feature) {
    const slot = await generateWorkspaceCompose(
      feature,
      meta["SERVICES"] ?? "",
      workspaceRoot,
      (meta["TEST_PATH"] ?? "").trim(),
      repos.map(([name]) => name),
    );
    if (slot !== null) {
      // 9. Build images (without starting containers)
      info("Building Docker images (--no-start)...");
      // The build is chatty and slow, so a terminal caller watches it live via
      // inherited stdio. An in-process one owns no TTY (its stdout may be an
      // MCP transport), so capture and replay through the reporter instead.
      const live = passthrough();
      const result = procRun(["docker", "compose", "up", "--build", "--no-start"], {
        cwd: workspaceRoot,
        ...(live ? { stdio: "inherit" as const } : { capture: true }),
      });
      if (!live) {
        if (result.stdout) raw(result.stdout);
        if (result.stderr) raw(result.stderr, "stderr");
      }
      if (result.status === 0) {
        success("Docker images built successfully.");
      } else {
        warn("docker compose build exited non-zero — images may be incomplete.");
      }
    }
  }

  raw(
    `\n${Colors.BOLD}Workspace initialised.${Colors.RESET} ` +
      "Open a new Claude Code session from the workspace root to pick up the context.\n\n",
  );
}

// ---------------------------------------------------------------------------
// init-workspace hand-off
// ---------------------------------------------------------------------------

/**
 * Run {@link initWorkspace} against the directory just created, with the root
 * handed over explicitly so nothing has to resolve it from a cwd.
 *
 * Returns a status the way the child process used to, because the caller's
 * "the workspace root exists at …, re-run from there" warning is keyed on it.
 */
async function runInitWorkspace(
  workspaceDir: string,
  featureSlug: string,
  resolved: Record<string, string>,
  opts: InitWorkspaceOptions,
): Promise<number> {
  info(`Running: sandbox init-workspace (feature: ${featureSlug})`);
  try {
    await initWorkspace({ ...resolved, feature: featureSlug, force: opts.force }, workspaceDir, opts);
    return 0;
  } catch (exc) {
    // A WorkspaceInitError has already emitted its own `[err]` line — the
    // specific one — so don't restate it as a stringified throw. Anything else
    // arrives unreported. (`initWorkspace`'s two remaining aborts, missing root
    // and missing feature, are unreachable from here: we supply both.)
    if (!(exc instanceof WorkspaceInitError)) {
      error(`init-workspace failed: ${(exc as Error).message}`);
    }
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Workspace creation
// ---------------------------------------------------------------------------

/**
 * Create a workspace from already-resolved inputs and initialise it. Returns
 * the workspace directory.
 *
 * *resolved* is what `resolveInputs` produced — the CLI adds the interactive
 * wizard's answers to it first; `createWorkspace` passes it straight through.
 * This function does not prompt.
 */
export async function provisionWorkspace(
  resolved: Record<string, string>,
  opts: InitWorkspaceOptions = {},
): Promise<string> {
  const feature = (resolved.feature ?? "").trim();
  if (!feature) {
    fail(
      "A feature name is required (pass it as an argument, set it in " +
        "./.sandbox/workspace.yml, or run interactively).",
    );
  }

  // Validate before creating the worktree or writing workspace.yml below — an
  // unknown value should fail fast rather than leave a half-made workspace.
  parseStrategyId(resolved.context_strategy);

  const featureSlug = feature.toLowerCase();
  // The wizard ran after resolveInputs, so normalize its answer here too.
  const tracker = issueTracker();
  if (resolved.issue_id) {
    resolved.issue_id = tracker.parseRef(resolved.issue_id) ?? resolved.issue_id;
  }
  const workspaceName = buildWorkspaceName(feature, resolved.issue_id ? tracker.slug(resolved.issue_id) : null);
  if (!_SLUG_RE.test(workspaceName)) {
    fail(
      `Workspace name '${workspaceName}' is not a valid slug ` +
        "(expected lowercase letters, digits, and single hyphens).",
    );
  }

  const branch = buildBranchName(os.userInfo().username, workspaceName);
  const workspaceDir = path.join(resolveWorkspacesRoot(), workspaceName);

  // 2. Create the workspace ROOT (a sandbox-workspace worktree) and record the
  //    resolved inputs — including the repo set — in .sandbox/workspace.yml.
  if (fs.existsSync(workspaceDir)) {
    info(`Workspace already exists: ${workspaceDir} — re-running init-workspace.`);
  } else {
    const repos = await selectRepos(resolved.repos, resolved.services);
    resolved.repos = repos.join(",");
    createWorkspaceRoot(workspaceDir, branch, Boolean(opts.force));
    writeWorkspaceConfig(workspaceDir, resolved);
  }

  // 3. init-workspace inside the workspace.
  const rc = await runInitWorkspace(workspaceDir, featureSlug, resolved, opts);
  if (rc !== 0) {
    const message =
      `sandbox init-workspace exited with status ${rc}. ` +
      `The workspace root exists at ${workspaceDir}; ` +
      "re-run `sandbox init-workspace` from there once resolved.";
    warn(message);
    throw new WorkspaceInitError(message);
  }

  // 4. First commit of the workspace state (repo-rooted workspaces only).
  commitWorkspaceState(workspaceDir, workspaceName);

  raw(
    `\n${Colors.BOLD}Workspace ready.${Colors.RESET} ` +
      `cd ${workspaceDir} and open a Claude Code session from there.\n\n`,
  );
  return workspaceDir;
}
