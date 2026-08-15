/**
 * Synchronous subprocess helpers over `spawnSync`.
 *
 * `timeout` is in SECONDS, not milliseconds.
 *
 * Errors: a `ProcError` is thrown when
 *   - the executable is missing        (err.code === "ENOENT")
 *   - the timeout elapsed              (err.code === "ETIMEDOUT")
 *   - `check: true` and exit != 0      (err.code === undefined)
 * carrying `status`, `stdout`, `stderr`, and the `cmd` that ran.
 */

import { spawnSync } from "node:child_process";

export interface RunOptions {
  /** Throw a ProcError when the command exits non-zero. */
  check?: boolean;
  /** Capture stdout/stderr as strings. Default: inherit. */
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text piped to stdin. */
  input?: string;
  /** Explicit inherit — same as omitting `capture`; kept for readable call sites. */
  stdio?: "inherit";
  /** Timeout in seconds. */
  timeout?: number;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class ProcError extends Error {
  status: number;
  stdout: string;
  stderr: string;
  cmd: string[];
  /** "ENOENT" (missing executable), "ETIMEDOUT" (timeout), else undefined. */
  code?: string;

  constructor(
    message: string,
    cmd: string[],
    status: number,
    stdout = "",
    stderr = "",
    code?: string,
  ) {
    super(message);
    this.name = "ProcError";
    this.cmd = cmd;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  const stdio: ("pipe" | "inherit")[] = opts.capture
    ? ["pipe", "pipe", "pipe"]
    : ["inherit", "inherit", "inherit"];
  if (opts.input !== undefined) stdio[0] = "pipe";

  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
    encoding: "utf8",
    stdio,
  });

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";

  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new ProcError(
        `Command timed out after ${opts.timeout}s: ${cmd.join(" ")}`,
        cmd, res.status ?? -1, stdout, stderr, "ETIMEDOUT",
      );
    }
    if (code === "ENOENT") {
      throw new ProcError(
        `Command not found: ${cmd[0]}`,
        cmd, -1, stdout, stderr, "ENOENT",
      );
    }
    throw new ProcError(
      `Command failed to start: ${cmd.join(" ")} (${res.error.message})`,
      cmd, res.status ?? -1, stdout, stderr, code,
    );
  }

  // Killed by signal -> negative status.
  const status = res.status ?? -1;

  if (opts.check && status !== 0) {
    throw new ProcError(
      `Command failed with exit code ${status}: ${cmd.join(" ")}`,
      cmd, status, stdout, stderr,
    );
  }
  return { status, stdout, stderr };
}

/** Run with capture + check semantics and return trimmed stdout. */
export function capture(cmd: string[], opts: RunOptions = {}): string {
  return run(cmd, { ...opts, capture: true, check: true }).stdout.trim();
}
