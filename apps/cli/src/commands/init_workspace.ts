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
 * 2. Generate/overwrite CLAUDE.md, .env, compose.yml, the projected
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
 *
 * All of that lives in `werkmeister-core/workspace_init` (note 086 row 5), where the
 * dashboard reaches it without spawning this CLI. What is left here is the argv
 * adapter: the prompt-spec exports, the interactive wizard driver, the one thing
 * a library may not do (read this process's stdin), and exit codes.
 */

import * as fs from "node:fs";

import {
  initWorkspace,
  WorkspaceInitError,
  WorkspaceRootError,
} from "werkmeister-core/workspace_init";

/**
 * Read a task title piped on stdin (`echo "…" | sandbox init-workspace`).
 *
 * This is the CLI's affordance, not the library's: only a process that owns fd
 * 0 may consume it, which is why `initWorkspace` takes this as a callback and
 * in-process callers pass none.
 */
export function readStdinTask(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Execute `sandbox init-workspace`. */
export async function run(args: Record<string, unknown>): Promise<void> {
  try {
    await initWorkspace(args, undefined, { readStdinTask });
  } catch (exc) {
    // Both carry a message that has already been shown: WorkspaceRootError's is
    // pre-rendered (it predates the reporter), WorkspaceInitError's went out as
    // an `[err]` line where it happened. Printing either again is the one thing
    // main.ts's handler would do, so exit here instead.
    if (exc instanceof WorkspaceRootError) {
      console.log(exc.message);
      process.exit(1);
    }
    if (exc instanceof WorkspaceInitError) {
      process.exit(1);
    }
    throw exc;
  }
}
