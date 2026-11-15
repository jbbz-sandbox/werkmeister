/**
 * `WorkspaceError`'s code. Named because `main.ts` matches on it to keep those
 * messages printing as `Error: …`, and a literal in each package would let the
 * two drift silently — the CLI would just start formatting them differently.
 */
export const WORKSPACE_ERROR_CODE = "WORKSPACE";

// Lets a library function fail without ending the process: the command sequences
// (`up`/`down`/`stop`/`restart`/`connect`/`status`) throw this instead of exit(1), and the
// CLI's top-level handler in `main.ts` turns it back into the same `[err]` line and exit
// status. Every code maps to exit 1.
/**
 * The base class of every error the SDK throws on purpose. Its `message` is written for a person
 * to read; its `code` names the kind of failure, so your code can branch on it without parsing
 * the message. {@link WorkspaceError} and `DaemonUnavailable` extend it.
 *
 * @example
 * ```ts
 * import { callTool, SandboxError } from "werkmeister-core/sdk";
 *
 * try {
 *   await callTool("status");
 * } catch (e) {
 *   if (e instanceof SandboxError && e.code === "DAEMON_TIMEOUT") console.log("still running: don't retry");
 *   else throw e;
 * }
 * ```
 */
export class SandboxError extends Error {
  /**
   * @param message - What went wrong, for a person to read.
   * @param code - The failure kind.
   */
  constructor(
    message: string,
    /** Machine-readable failure kind, e.g. `WORKSPACE`, `DAEMON_DOWN`. */
    readonly code: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

// One code for all ~45 throw sites: they predate `SandboxError` and none of their callers
// branches on anything finer than the class. Giving them distinct codes is a separate change
// nothing has asked for yet.
/**
 * The error most SDK functions throw: a workspace that does not exist, a bad name, a command
 * that is not installed, a create or action that failed. Its `message` says what went wrong in
 * words a person can act on, and its `code` is always `WORKSPACE`. It extends
 * {@link SandboxError}.
 *
 * @example
 * ```ts
 * import { resolveWorkspaceDir, WorkspaceError } from "werkmeister-core/sdk";
 *
 * try {
 *   console.log(await resolveWorkspaceDir("no-such-workspace"));
 * } catch (e) {
 *   if (e instanceof WorkspaceError) console.log(e.code, e.message); // "WORKSPACE"
 *   else throw e;
 * }
 * ```
 */
export class WorkspaceError extends SandboxError {
  /** @param message - What went wrong, for a person to read. */
  constructor(message: string) {
    super(message, WORKSPACE_ERROR_CODE);
    this.name = "WorkspaceError";
  }
}
