/**
 * A user-facing failure carrying a machine-readable *code*.
 *
 * This is what lets a library function fail without ending the process. The six
 * command sequences (`up`/`down`/`stop`/`restart`/`connect`/`status`) exit(1)
 * today, which a long-lived caller — the dashboard, an MCP server — cannot
 * survive; they throw this instead, and the CLI's top-level handler in
 * `main.ts` turns it back into the same `[err]` line and exit status.
 *
 * *code* exists for the in-process caller to branch on, not for the CLI: every
 * code maps to exit 1.
 */
/**
 * `WorkspaceError`'s code. Named because `main.ts` matches on it to keep those
 * messages printing as `Error: …`, and a literal in each package would let the
 * two drift silently — the CLI would just start formatting them differently.
 */
export const WORKSPACE_ERROR_CODE = "WORKSPACE";

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}
