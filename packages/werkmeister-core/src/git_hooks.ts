/**
 * Idempotent core.hooksPath auto-configuration for the werkmeister secret-commit guard.
 *
 * Wires the repo's git hooks to the versioned `.githooks/` directory so the
 * `.githooks/pre-commit` guard (see PLAN 03-02) is active without requiring
 * every developer to run the manual `git config core.hooksPath .githooks`
 * one-liner themselves.
 *
 * Never clobbers a pre-existing, non-default, non-`.githooks` hooksPath — a
 * developer who has intentionally configured a custom hooksPath keeps it, and
 * is warned that the werkmeister secret-commit guard was not installed (D-12).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { sandboxRoot } from "./config.js";
import { ProcError, run } from "./proc.js";
import { info, success, warn } from "./reporter.js";

export const HOOKS_PATH = ".githooks";

/**
 * Idempotently point `core.hooksPath` at `.githooks`.
 *
 * @param repoRoot Repo root to configure. Defaults to `sandboxRoot()`.
 * @returns True if `core.hooksPath` is (now, or already) `.githooks`.
 *   False if a pre-existing, different, non-default hooksPath was left
 *   untouched (non-clobber behavior).
 */
export function configureGitHooksPath(repoRoot?: string | null): boolean {
  const root = repoRoot ?? sandboxRoot();

  // Installed from npm rather than run from a checkout: there is no repo to
  // guard, and git would answer `fatal: not in a git directory` — a warning on
  // every `werkmeister infra connect` about a hook nobody wanted. `.git` is a file in a
  // worktree and a directory in a clone; existsSync accepts both.
  if (!fs.existsSync(path.join(root, ".git"))) {
    return false;
  }

  let result;
  try {
    result = run(["git", "-C", root, "config", "--get", "core.hooksPath"], { capture: true });
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") {
      // Informational only — a missing git binary should warn, not block
      // `werkmeister infra connect`.
      warn(
        "git was not found on PATH — could not check or configure " +
          `core.hooksPath. The werkmeister secret-commit guard (${HOOKS_PATH}/` +
          "pre-commit) was NOT installed.",
      );
      return false;
    }
    throw e;
  }

  const current = result.status === 0 ? result.stdout.trim() : "";

  if (current === HOOKS_PATH) {
    // Already configured — no-op, no warning (D-12 idempotency).
    return true;
  }

  if (current) {
    warn(
      `core.hooksPath is already set to '${current}' — leaving it unchanged. ` +
        `The werkmeister secret-commit guard (${HOOKS_PATH}/pre-commit) was NOT ` +
        `installed. Run 'git config core.hooksPath ${HOOKS_PATH}' manually if ` +
        "you want to activate it.",
    );
    return false;
  }

  try {
    run(["git", "-C", root, "config", "core.hooksPath", HOOKS_PATH], {
      capture: true,
      check: true,
    });
  } catch (e) {
    const detail =
      e instanceof ProcError && e.code === undefined && e.stderr
        ? e.stderr.trim()
        : String(e instanceof Error ? e.message : e);
    warn(
      `Could not set core.hooksPath to ${HOOKS_PATH} (${detail}). ` +
        `The werkmeister secret-commit guard (${HOOKS_PATH}/pre-commit) was NOT ` +
        "installed.",
    );
    return false;
  }

  info(`Configuring core.hooksPath -> ${HOOKS_PATH} (first-time setup)...`);
  success(`core.hooksPath set to ${HOOKS_PATH} (secret-commit guard active)`);
  return true;
}
