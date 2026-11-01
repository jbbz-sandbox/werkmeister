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

import { spawn, spawnSync } from "node:child_process";
import { toolBin } from "./tool_bins.js";

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

  const res = spawnSync(toolBin(cmd[0]), cmd.slice(1), {
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
        cmd,
        res.status ?? -1,
        stdout,
        stderr,
        "ETIMEDOUT",
      );
    }
    if (code === "ENOENT") {
      throw new ProcError(`Command not found: ${cmd[0]}`, cmd, -1, stdout, stderr, "ENOENT");
    }
    throw new ProcError(
      `Command failed to start: ${cmd.join(" ")} (${res.error.message})`,
      cmd,
      res.status ?? -1,
      stdout,
      stderr,
      code,
    );
  }

  // Killed by signal -> negative status.
  const status = res.status ?? -1;

  if (opts.check && status !== 0) {
    throw new ProcError(
      `Command failed with exit code ${status}: ${cmd.join(" ")}`,
      cmd,
      status,
      stdout,
      stderr,
    );
  }
  return { status, stdout, stderr };
}

/** Run with capture + check semantics and return trimmed stdout. */
export function capture(cmd: string[], opts: RunOptions = {}): string {
  return run(cmd, { ...opts, capture: true, check: true }).stdout.trim();
}

export interface AsyncRunOptions extends RunOptions {
  /**
   * Aborting kills the child and rejects with a ProcError whose `code` is
   * "ABORT_ERR". A synchronous `run` has no equivalent, which is the whole
   * reason this function exists.
   */
  signal?: AbortSignal;
}

/**
 * The async, cancellable sibling of {@link run}.
 *
 * Same options and the same ProcError contract, plus `signal`. Use it for
 * anything that can run for more than a moment -- compose, playwright,
 * telepresence -- so a caller that is not a dying CLI process can still stop it.
 *
 * An abort and a timeout both kill the child, and a child that traps the
 * signal picks its own exit status, so the two are told apart by asking the
 * AbortSignal rather than by the exit or by which event arrives first: Node
 * emits "error" for an abort and only "close" for a timeout, but nothing orders
 * them against each other.
 */
export function runAsync(cmd: string[], opts: AsyncRunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdio: ("pipe" | "inherit")[] = opts.capture
      ? ["pipe", "pipe", "pipe"]
      : ["inherit", "inherit", "inherit"];
    if (opts.input !== undefined) stdio[0] = "pipe";

    const child = spawn(toolBin(cmd[0]), cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio,
      signal: opts.signal,
      timeout: opts.timeout !== undefined ? opts.timeout * 1000 : undefined,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }

    // Both "error" and "close" can fire for one child; the first verdict wins.
    let settled = false;
    const fail = (message: string, status: number, code?: string): void => {
      if (settled) return;
      settled = true;
      reject(new ProcError(message, cmd, status, stdout, stderr, code));
    };
    const done = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout, stderr });
    };
    const aborted = (): boolean => opts.signal?.aborted === true;

    child.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (aborted()) {
        fail(`Command aborted: ${cmd.join(" ")}`, -1, "ABORT_ERR");
        return;
      }
      if (code === "ENOENT") {
        fail(`Command not found: ${cmd[0]}`, -1, "ENOENT");
        return;
      }
      fail(`Command failed to start: ${cmd.join(" ")} (${e.message})`, -1, code);
    });

    child.on("close", (status) => {
      if (aborted()) {
        fail(`Command aborted: ${cmd.join(" ")}`, -1, "ABORT_ERR");
        return;
      }
      // Not aborted, so a kill can only be the timeout we passed to spawn. Asked of
      // the child, not its exit shape: docker compose traps the SIGTERM and exits
      // 130 with no signal (SW-86).
      if (child.killed && opts.timeout !== undefined) {
        fail(`Command timed out after ${opts.timeout}s: ${cmd.join(" ")}`, -1, "ETIMEDOUT");
        return;
      }
      const code = status ?? -1;
      if (opts.check && code !== 0) {
        fail(`Command failed with exit code ${code}: ${cmd.join(" ")}`, code);
        return;
      }
      done(code);
    });
  });
}
