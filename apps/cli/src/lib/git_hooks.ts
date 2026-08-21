/**
 * Idempotent core.hooksPath auto-configuration for the sandbox secret-commit guard.
 *
 * Wires the repo's git hooks to the versioned `.githooks/` directory so the
 * `.githooks/pre-commit` guard (see PLAN 03-02) is active without requiring
 * every developer to run the manual `git config core.hooksPath .githooks`
 * one-liner themselves.
 *
 * Never clobbers a pre-existing, non-default, non-`.githooks` hooksPath — a
 * developer who has intentionally configured a custom hooksPath keeps it, and
 * is warned that the sandbox secret-commit guard was not installed (D-12).
 */

import { getSandboxRoot, info, success, warn } from "./config.js";
import { ProcError, run } from "sandbox-core/proc";

export const HOOKS_PATH = ".githooks";

/**
 * Idempotently point `core.hooksPath` at `.githooks`.
 *
 * @param repoRoot Repo root to configure. Defaults to `getSandboxRoot()`.
 * @returns True if `core.hooksPath` is (now, or already) `.githooks`.
 *   False if a pre-existing, different, non-default hooksPath was left
 *   untouched (non-clobber behavior).
 */
export function configureGitHooksPath(repoRoot?: string | null): boolean {
  const root = repoRoot ?? getSandboxRoot();

  let result;
  try {
    result = run(["git", "-C", root, "config", "--get", "core.hooksPath"], { capture: true });
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") {
      // Informational only — a missing git binary should warn, not block
      // `sandbox connect`.
      warn(
        "git was not found on PATH — could not check or configure " +
          `core.hooksPath. The sandbox secret-commit guard (${HOOKS_PATH}/` +
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
        `The sandbox secret-commit guard (${HOOKS_PATH}/pre-commit) was NOT ` +
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
        `The sandbox secret-commit guard (${HOOKS_PATH}/pre-commit) was NOT ` +
        "installed.",
    );
    return false;
  }

  info(`Configuring core.hooksPath -> ${HOOKS_PATH} (first-time setup)...`);
  success(`core.hooksPath set to ${HOOKS_PATH} (secret-commit guard active)`);
  return true;
}
