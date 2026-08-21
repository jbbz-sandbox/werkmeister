/**
 * sandbox workspace <feature> [options]
 *
 * Create a brand-new sandbox workspace under ``$SANDBOX_WORKSPACES_ROOT`` and
 * initialise it.
 *
 * This command owns workspace *creation*; ``sandbox init-workspace`` owns
 * everything derived from the config. Concretely, ``workspace``:
 *
 *   1. resolves inputs (CLI switches / an existing workspace.yml / the interactive
 *      wizard) — a ``feature`` is required;
 *   2. creates the workspace directory as a git worktree of the dedicated
 *      ``sandbox-workspace`` repo (``overrides.workspace_repo``) on the
 *      ``<user>/<workspace>`` branch — the container the nested repo worktrees
 *      live in. Without a local ``sandbox-workspace`` checkout the root falls
 *      back to a plain directory (no history);
 *   3. writes ``.sandbox/workspace.yml`` (the durable source of truth, including
 *      the resolved ``repos`` set); and
 *   4. runs ``sandbox init-workspace`` inside it, which creates the nested repo
 *      worktrees from that config and writes CLAUDE.md / .env /
 *      docker-compose.yml / .claude/ / .sandbox/*. The initial state is then
 *      committed (not pushed).
 *
 * The workspace directory name is derived from the optional Jira ticket id and
 * the feature name. Workspace state (.sandbox/workspace.yml, .sandbox/notes/, the
 * projected .claude/ and generated context files) is tracked on the branch; the
 * nested repo worktrees and .env are gitignored.
 *
 * Naming
 * ------
 *     feature only           dir: feature              branch: <user>/feature
 *     jira + feature         dir: proj-123-feature       branch: <user>/proj-123-feature
 *
 * (The Jira id is lower-cased and prefixed to the feature name.)
 *
 * See the module docstring for the full input/repo resolution rules.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  Colors,
  error,
  expandUser,
  getMonorepoRoot,
  getReposRoot,
  getSandboxRoot,
  info,
  loadReposConfig,
  loadServices,
  success,
  warn,
} from "../lib/config.js";
import { buildFormSchema } from "../lib/form_schema.js";
import { loadPaths } from "../lib/global_config.js";
// The workspace ROOT is itself a worktree of the dedicated sandbox-workspace
// repo (which one is `overrides.workspace_repo`) — rationale and the clone/update logic
// live with the constant in machine_setup (`sandbox setup` maintains the
// checkout this command consumes).
import { WORKSPACE_ROOT_REPO } from "../lib/machine_setup.js";
import { run as procRun } from "sandbox-core/proc";
import { PromptSpec } from "../lib/wizard.js";
// Worktree creation is shared with init-workspace (which owns the nested
// per-repo worktrees); this command creates only the workspace ROOT.
import { createWorktree, resolveRepos } from "sandbox-core/worktrees";
// init-workspace owns the shared prompt/wizard definitions and config writer;
// these helpers are re-used verbatim so both commands agree on fields.
import {
  buildPromptSpec,
  emitSpecError,
  promptEntry,
  resolveInputs,
  runInteractiveWizard,
  writeWorkspaceConfig,
} from "./init_workspace.js";

// A workspace directory / feature slug: lowercase, hyphen-separated.
const _SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The single definition of the workspace-only "additional repos" prompt. Both
// the interactive wizard (spliced in after `services`) and the `--print-prompts`
// / browser-form exports (serialised via `promptEntry`) render from this one
// spec, so the two paths can't drift apart again.
const REPOS_PROMPT: PromptSpec = {
  key: "repos",
  label: "Additional repos (optional)",
  help:
    "Extra repos to create worktrees for. The final set is the union of " +
    "these and the repos owning the services selected above.",
  multi: true,
  choicesFn: () => Object.keys(loadReposConfig()).sort(),
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function buildWorkspaceName(feature: string, jiraId: string | null): string {
  const featureSlug = (feature || "").trim().toLowerCase();
  const jiraSlug = (jiraId || "").trim().toLowerCase();
  return jiraSlug ? `${jiraSlug}-${featureSlug}` : featureSlug;
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

function createWorkspaceRoot(workspaceDir: string, branch: string): void {
  const reposRoot = resolveReposRoot();
  const rootRepoSrc = path.join(reposRoot, WORKSPACE_ROOT_REPO);

  info(`Workspace:  ${workspaceDir}`);
  info(`Branch:     ${branch}`);

  if (fs.existsSync(path.join(rootRepoSrc, ".git"))) {
    try {
      createWorktree(rootRepoSrc, workspaceDir, branch);
    } catch (exc) {
      error(`Failed to create workspace root worktree: ${(exc as Error).message}`);
      process.exit(1);
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

// ---------------------------------------------------------------------------
// init-workspace hand-off
// ---------------------------------------------------------------------------

function runInitWorkspace(
  workspaceDir: string,
  featureSlug: string,
  resolved: Record<string, string>,
): number {
  // Invoke the CLI entry by path so init-workspace's CWD-based detection
  // resolves the new workspace.
  const sandboxRoot = String(getSandboxRoot());
  const mainJs = path.join(getSandboxRoot(), "dist", "main.js");
  const flags = initWorkspaceFlags(featureSlug, resolved);
  const cmd = [process.execPath, mainJs, "init-workspace", ...flags];

  const env = { ...process.env };
  env.SANDBOX_ROOT = sandboxRoot;

  info("Running: sandbox init-workspace " + flags.join(" "));
  const result = procRun(cmd, { cwd: workspaceDir, env });
  return result.status;
}

// ---------------------------------------------------------------------------
// Entry point helpers
// ---------------------------------------------------------------------------

async function resolveWorkspaceInputs(args: Record<string, unknown>): Promise<Record<string, string>> {
  const base = process.cwd();
  let resolved = resolveInputs(args, base);
  // On a TTY, run the wizard for whatever's still unresolved — `runWizard`
  // skips any field already supplied via CLI/env/config, so a passed feature
  // just pre-fills that one prompt rather than skipping the wizard entirely.
  // Piped/non-TTY invocations fall through to flags + config only.
  if (process.stdin.isTTY) {
    resolved = await runInteractiveWizard(base, resolved, [REPOS_PROMPT]);
  }
  return resolved;
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
    error(
      `Unknown service(s): ${unknown.join(", ")}. ` +
        "See `sandbox services` / config/services.yaml.",
    );
    process.exit(1);
  }

  if (!resolvedRepos.length) {
    // On a TTY the wizard already offered services + repos; a non-TTY run had
    // only flags/config. Either way, nothing selected means nothing to create.
    error(
      "No repos selected. Choose at least one service or repo in the wizard, " +
        "or pass --services svc1,svc2 / --repos r1,r2.",
    );
    process.exit(1);
  }

  return resolvedRepos;
}

function initWorkspaceFlags(featureSlug: string, resolved: Record<string, string>): string[] {
  const flags = ["--feature", featureSlug];
  const mapping: [string, string][] = [
    ["jira_id", "--jira-id"],
    ["repos", "--repos"],
    ["services", "--services"],
    ["test_path", "--test-path"],
    ["description", "--description"],
    ["task", "--task"],
    ["starting_prompt", "--starting-prompt"],
    ["work_type", "--work-type"],
    ["labels", "--labels"],
  ];
  for (const [key, flag] of mapping) {
    const value = resolved[key];
    if (value) {
      flags.push(flag, value);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Prompt / form-schema export (delegated to init-workspace's definitions)
// ---------------------------------------------------------------------------

function reposPromptEntry(resolved: Record<string, string>): Record<string, unknown> {
  // workspaceRoot is only consulted for a spec's defaultFn; REPOS_PROMPT has
  // none, so the value is irrelevant. Serialising the shared spec keeps this
  // export byte-identical to what the wizard now presents.
  return promptEntry(REPOS_PROMPT, "", resolved);
}

function computePromptSpec(args: Record<string, unknown>): Record<string, unknown> {
  // Diagnostics go to stderr so stdout stays a clean JSON document.
  const base = process.cwd();
  let resolved: Record<string, string>;
  let spec: Record<string, unknown>;
  const origLog = console.log;
  try {
    console.log = ((...a: unknown[]) => console.error(...a)) as typeof console.log;
    resolved = resolveInputs(args, base);
    spec = buildPromptSpec(base, resolved);
  } finally {
    console.log = origLog;
  }

  const reposEntry = reposPromptEntry(resolved);
  if ((reposEntry.choices as string[]).length) {
    const prompts = (spec.prompts as Record<string, unknown>[]) ?? [];
    let servicesIdx = prompts.findIndex((p) => p.key === "services");
    if (servicesIdx === -1) {
      servicesIdx = prompts.length - 1;
    }
    prompts.splice(servicesIdx + 1, 0, reposEntry);
    spec.prompts = prompts;
  }
  return spec;
}

function printPrompts(args: Record<string, unknown>): void {
  let spec: Record<string, unknown>;
  try {
    spec = computePromptSpec(args);
  } catch (exc) {
    emitSpecError(exc);
    return;
  }
  process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
}

function printFormSchema(args: Record<string, unknown>): void {
  let spec: Record<string, unknown>;
  try {
    spec = computePromptSpec(args);
  } catch (exc) {
    emitSpecError(exc);
    return;
  }
  process.stdout.write(JSON.stringify(buildFormSchema(spec), null, 2) + "\n");
}

/** Locate an executable on PATH. */
function which(cmd: string): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* not here */
    }
  }
  return null;
}

function runBrowserForm(args: Record<string, unknown>): void {
  const cliJs = path.join(getMonorepoRoot(), "apps", "sandbox-dashboard", "dist", "form-cli.js");
  if (!(fs.existsSync(cliJs) && fs.statSync(cliJs).isFile())) {
    error(
      `Browser form not built: ${cliJs} is missing. ` +
        "Run `npm --prefix apps/sandbox-dashboard run build` (or `sandbox mcp` once) first.",
    );
    process.exit(1);
  }
  const node = which("node");
  if (!node) {
    error("`node` not found on PATH — the browser form requires Node.js.");
    process.exit(1);
  }

  const cmd = [node, cliJs];
  if (args.jira_id) {
    cmd.push("--jira", args.jira_id as string);
  }
  if (args.open_vscode) {
    cmd.push("--open");
  }

  // Inherit stdio: node's stdout (outcome JSON) and stderr (progress) flow
  // straight through to our caller.
  const result = procRun(cmd, { stdio: "inherit" });
  process.exit(result.status);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  // 0. Prompt-spec exports — emit and exit without touching the filesystem.
  if (args.print_prompts) {
    printPrompts(args);
    return;
  }
  if (args.print_form_schema) {
    printFormSchema(args);
    return;
  }

  // 0b. Branded browser-form path — collect inputs in the browser, then create.
  if (args.browser_form) {
    runBrowserForm(args);
    return;
  }

  // 1. Resolve inputs (CLI > ./.sandbox/workspace.yml > interactive).
  const resolved = await resolveWorkspaceInputs(args);
  const feature = (resolved.feature ?? "").trim();
  if (!feature) {
    error(
      "A feature name is required (pass it as an argument, set it in " +
        "./.sandbox/workspace.yml, or run interactively).",
    );
    process.exit(1);
  }

  const featureSlug = feature.toLowerCase();
  const jiraId = (resolved.jira_id ?? "").trim() || null;
  const workspaceName = buildWorkspaceName(feature, jiraId);
  if (!_SLUG_RE.test(workspaceName)) {
    error(
      `Workspace name '${workspaceName}' is not a valid slug ` +
        "(expected lowercase letters, digits, and single hyphens).",
    );
    process.exit(1);
  }

  const branch = buildBranchName(os.userInfo().username, workspaceName);
  const workspacesRoot = resolveWorkspacesRoot();
  const workspaceDir = path.join(workspacesRoot, workspaceName);

  // 2. Create the workspace ROOT (a sandbox-workspace worktree) and record the
  //    resolved inputs — including the repo set — in .sandbox/workspace.yml.
  if (fs.existsSync(workspaceDir)) {
    info(`Workspace already exists: ${workspaceDir} — re-running init-workspace.`);
  } else {
    const repos = await selectRepos(resolved.repos, resolved.services);
    resolved.repos = repos.join(",");
    createWorkspaceRoot(workspaceDir, branch);
    writeWorkspaceConfig(workspaceDir, resolved);
  }

  // 3. init-workspace inside the workspace.
  const rc = runInitWorkspace(workspaceDir, featureSlug, resolved);
  if (rc !== 0) {
    warn(
      `sandbox init-workspace exited with status ${rc}. ` +
        `The workspace root exists at ${workspaceDir}; ` +
        "re-run `sandbox init-workspace` from there once resolved.",
    );
    process.exit(rc);
  }

  // 4. First commit of the workspace state (repo-rooted workspaces only).
  commitWorkspaceState(workspaceDir, workspaceName);

  console.log(
    `\n${Colors.BOLD}Workspace ready.${Colors.RESET} ` +
      `cd ${workspaceDir} and open a Claude Code session from there.\n`,
  );
}
