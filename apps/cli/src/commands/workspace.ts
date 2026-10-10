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

import { error, getMonorepoRoot } from "../lib/config.js";
import { run as procRun } from "sandbox-core/proc";
// The work itself lives in core (note 086 row 5), which is how `createWorkspace`
// runs it without spawning this CLI. What stays here is the wizard, the
// browser-form launcher, and exit codes.
import { WorkspaceInitError, provisionWorkspace } from "sandbox-core/workspace_init";
// init-workspace owns the piped-stdin reader; the prompt definitions and the
// form schema built from them live in core, where the dashboard reaches them
// without spawning this CLI (note 087).
import { readStdinTask } from "./init_workspace.js";
import { runFormWizard } from "../lib/wizard.js";
import { buildFormSchema } from "sandbox-core/form_schema";
import { resolveInputs, workspacePromptSpec } from "sandbox-core/workspace_prompts";

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

async function resolveWorkspaceInputs(args: Record<string, unknown>): Promise<Record<string, string>> {
  const base = process.cwd();
  let resolved = resolveInputs(args, base);
  // On a TTY, run the wizard for whatever's still unresolved, rendered from the
  // same form schema the browser form uses. Fields already supplied via
  // CLI/env/config are left out of the schema, so a passed feature skips just
  // that one prompt rather than the whole wizard. Piped/non-TTY invocations
  // fall through to flags + config only.
  if (process.stdin.isTTY) {
    resolved = await runFormWizard(buildFormSchema(workspacePromptSpec(base, resolved)), resolved, {
      intro: "Interactive wizard — press Ctrl-C to abort. Defaults shown in [brackets].",
    });
  }
  return resolved;
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

  const cmd = [node, cliJs];
  if (args.issue_id) {
    cmd.push("--issue", args.issue_id as string);
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
  // 0. Branded browser-form path — collect inputs in the browser, then create.
  if (args.browser_form) {
    runBrowserForm(args);
    return;
  }

  // 1. Resolve inputs (CLI > ./.sandbox/workspace.yml > interactive), then hand
  //    the whole creation to core.
  try {
    await provisionWorkspace(await resolveWorkspaceInputs(args), { readStdinTask, force: Boolean(args.force) });
  } catch (exc) {
    // Its `[err]`/`[warn]` line is already out; restating it is all main.ts's
    // handler would do.
    if (exc instanceof WorkspaceInitError) {
      process.exit(1);
    }
    throw exc;
  }
}
