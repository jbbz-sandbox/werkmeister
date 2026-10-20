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
 *      compose.yml / .claude/ / .sandbox/*. The initial state is then
 *      committed (not pushed).
 *
 * The workspace directory name is derived from the optional issue ID and
 * the feature name. Workspace state (.sandbox/workspace.yml, .sandbox/notes/, the
 * projected .claude/ and generated context files) is tracked on the branch; the
 * nested repo worktrees and .env are gitignored.
 *
 * Naming
 * ------
 *     feature only           dir: feature              branch: <user>/feature
 *     issue + feature        dir: <slug>-feature         branch: <user>/<slug>-feature
 *
 * (The issue's slug, e.g. PROJ-123 -> proj-123, is prefixed to the feature name.)
 *
 * See the module docstring for the full input/repo resolution rules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
// The work itself lives in core (note 086 row 5), which is how `createWorkspace`
// runs it without spawning this CLI. What stays here is the wizard, the
// browser-form launcher, and exit codes.
import { createWorkspace, distillIssue, WorkspaceError } from "werkmeister-core";
import { workspacesRoot } from "werkmeister-core/config";
import { buildFormSchema, repoSelectionError } from "werkmeister-core/form_schema";
import { fetchIssueSnapshot, type IssueSnapshot } from "werkmeister-core/issue_snapshot";
import { issueTracker } from "werkmeister-core/issue_tracker";
import { run as procRun } from "werkmeister-core/proc";
import { WorkspaceInitError } from "werkmeister-core/workspace_init";
import { resolveInputs, workspacePromptSpec } from "werkmeister-core/workspace_prompts";
import { error, getMonorepoRoot, info, warn } from "../lib/config.js";
import { askField, fieldsOf, runFormWizard } from "../lib/wizard.js";
// init-workspace owns the piped-stdin reader; the prompt definitions and the
// form schema built from them live in core, where the dashboard reaches them
// without spawning this CLI (note 087).
import { readStdinTask } from "./init_workspace.js";

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

/** True when *dir* sits inside the workspaces root, i.e. is a workspace someone made by hand. */
function insideWorkspacesRoot(dir: string): boolean {
  const rel = path.relative(workspacesRoot(), path.resolve(dir));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `repoSelectionError` over the wizard's comma-separated answers. */
function wizardRepoError(resolved: Record<string, string>): string | null {
  const list = (v?: string) => (v ?? "").split(",").filter((s) => s.trim());
  return repoSelectionError({ services: list(resolved.services), repos: list(resolved.repos) });
}

export async function resolveWorkspaceInputs(
  args: Record<string, unknown>,
): Promise<{ resolved: Record<string, string>; issue?: IssueSnapshot }> {
  const base = process.cwd();
  let resolved = resolveInputs(args, base);
  let issue: IssueSnapshot | undefined;
  const preset = new Set(Object.keys(resolved));
  // On a TTY, run the wizard for whatever's still unresolved, rendered from the
  // same form schema the browser form uses. Fields already supplied via
  // CLI/env/config are left out of the schema, so a passed feature skips just
  // that one prompt rather than the whole wizard. Piped/non-TTY invocations
  // fall through to flags + config only.
  if (process.stdin.isTTY) {
    // Defaults derived from the cwd (feature, task, issue) only mean something in a
    // workspace dir; from ~ or the workspaces root they'd name the user or the root (SW-51).
    const bundle = buildFormSchema(
      workspacePromptSpec(base, resolved, { defaults: insideWorkspacesRoot(base) }),
    );
    resolved = await runFormWizard(bundle, resolved, {
      intro:
        "Interactive wizard — press Ctrl-C to abort. Defaults shown in [brackets]; leave a field blank to skip it.",
      // Typed in the wizard: read the issue now so later prompts default to it.
      afterField: async (key, r): Promise<Record<string, string>> => {
        // An issue from flag/env/config is createWorkspace's to read.
        if (key !== "issue_id" || !r.issue_id || preset.has("issue_id")) return {};
        const tracker = issueTracker();
        const ref = tracker.parseRef(r.issue_id);
        // A bad ref or a failed read stops the wizard: run prints it once and exits 1.
        if (!ref)
          throw new WorkspaceError(
            `${r.issue_id} isn't a ${tracker.label} issue ref (e.g. ${tracker.refExample})`,
          );
        r.issue_id = ref;
        try {
          issue = await fetchIssueSnapshot(ref);
        } catch {
          throw new WorkspaceError(
            `couldn't read ${ref} from ${tracker.label}; run \`sandbox connect\` to check the issue tracker.`,
          );
        }
        if (args.no_distill) return { task: issue.title };
        const { fields, warning } = await distillIssue(issue);
        if (warning) info(`Issue read; fields not pre-filled: ${warning}`);
        return { task: issue.title, ...fields };
      },
    });
    // The GUIs' rule: at least one service or repo. Re-ask just those two fields.
    const repoFields = fieldsOf(bundle).filter((f) => f.key === "services" || f.key === "repos");
    for (let err = wizardRepoError(resolved); err; err = wizardRepoError(resolved)) {
      if (!repoFields.length) throw new WorkspaceError(err);
      warn(err);
      for (const field of repoFields) await askField(field, resolved);
    }
  }
  return { resolved, issue };
}

// ---------------------------------------------------------------------------
// Browser form
// ---------------------------------------------------------------------------

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

/** CLI keys the form knows; everything else (browser_form, open_vscode, force, no_distill) is a CLI switch. */
const FORM_KEYS = [
  "feature",
  "issue_id",
  "services",
  "repos",
  "labels",
  "task",
  "test_path",
  "description",
  "starting_prompt",
  "work_type",
  "context_strategy",
  "autonomous",
  "model",
  "auto_stop",
];

/** Form fields that are arrays of choices (checkboxes); their comma-separated flag values are split. */
const ARRAY_KEYS = new Set(["services", "repos"]);

export function browserFormCommand(
  node: string,
  cliJs: string,
  args: Record<string, unknown>,
): string[] {
  const prefill = Object.fromEntries(
    FORM_KEYS.filter((k) => args[k] != null && args[k] !== "").map((k) => [
      k,
      ARRAY_KEYS.has(k)
        ? String(args[k])
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : args[k],
    ]),
  );
  const cmd = [node, cliJs];
  if (Object.keys(prefill).length) cmd.push("--prefill", JSON.stringify(prefill));
  if (args.issue_id) cmd.push("--issue", String(args.issue_id));
  if (args.open_vscode) cmd.push("--open");
  return cmd;
}

function runBrowserForm(args: Record<string, unknown>): void {
  const cliJs = path.join(getMonorepoRoot(), "apps", "sandbox-dashboard", "dist", "form-cli.js");
  if (!(fs.existsSync(cliJs) && fs.statSync(cliJs).isFile())) {
    error(
      `Browser form not built: ${cliJs} is missing. ` +
        "Run `npm --prefix apps/sandbox-dashboard run build` (or `sandbox dashboard` once) first.",
    );
    process.exit(1);
  }
  const node = which("node");
  if (!node) {
    error("`node` not found on PATH — the browser form requires Node.js.");
    process.exit(1);
  }

  const cmd = browserFormCommand(node, cliJs, args);

  // Inherit stdio: node's stdout (outcome JSON) and stderr (progress) flow
  // straight through to our caller.
  const result = procRun(cmd, { stdio: "inherit" });
  process.exit(result.status);
}

export async function run(args: Record<string, unknown>): Promise<void> {
  // 0. Branded browser-form path — collect inputs in the browser, then create.
  if (args.browser_form) {
    runBrowserForm(args);
    return;
  }

  // 1. Resolve inputs (CLI > ./.sandbox/workspace.yml > interactive), then hand
  //    the whole creation to core.
  try {
    const { resolved, issue } = await resolveWorkspaceInputs(args);
    await createWorkspace(resolved, {
      live: true,
      open: Boolean(args.open_vscode),
      cwd: process.cwd(),
      issue,
      // The wizard already distilled (and the person reviewed) when it read the issue.
      distill: args.no_distill || issue ? false : undefined,
      readStdinTask,
      force: Boolean(args.force),
    });
  } catch (exc) {
    // A WorkspaceInitError's `[err]` line is already out; restating it would print twice.
    if (exc instanceof WorkspaceInitError) process.exit(1);
    if (exc instanceof WorkspaceError) {
      error(exc.message);
      process.exit(1);
    }
    throw exc;
  }
}
