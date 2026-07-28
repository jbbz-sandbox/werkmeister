/**
 * Synchronous subprocess helpers replacing Python's `subprocess.run`.
 *
 * The Python CLI's dominant call shapes, mirrored here:
 *   subprocess.run(cmd, capture_output=True, text=True, timeout=N[, check=..])
 *       -> run(cmd, { capture: true, timeout: N[, check] })
 *   subprocess.run(cmd)                      (inherit stdio)
 *       -> run(cmd)  or  run(cmd, { stdio: "inherit" })
 *   subprocess.run(cmd, cwd=..., check=True) -> run(cmd, { cwd, check: true })
 *
 * `timeout` is in SECONDS (like Python) so call sites port verbatim.
 *
 * Errors: a `ProcError` is thrown when
 *   - the executable is missing        (err.code === "ENOENT",   FileNotFoundError)
 *   - the timeout elapsed              (err.code === "ETIMEDOUT", TimeoutExpired)
 *   - `check: true` and exit != 0      (err.code === undefined,  CalledProcessError)
 * carrying `status`, `stdout`, `stderr`, and the `cmd` that ran.
 */

import { spawnSync } from "node:child_process";

export interface RunOptions {
  /** Throw a ProcError when the command exits non-zero (Python check=True). */
  check?: boolean;
  /** Capture stdout/stderr as strings (Python capture_output=True). Default: inherit. */
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text piped to stdin (Python input=...). */
  input?: string;
  /** Explicit inherit — same as omitting `capture`; kept for readable call sites. */
  stdio?: "inherit";
  /** Timeout in seconds (Python timeout=...). */
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

  // Killed by signal -> negative status, like Python's returncode.
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
