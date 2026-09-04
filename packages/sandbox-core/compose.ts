/**
 * Docker Compose helpers for the developer sandbox.
 *
 * Wraps `docker compose` commands to manage per-feature container stacks.
 * As of Phase 3 each feature's compose file lives at
 * `<workspace>/docker-compose.yml` (the canonical location).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Colors } from "./colors.js";
import { resolveWorkspace } from "./config.js";
import { ProcError, run, runAsync, RunResult } from "./proc.js";
import { error, info, raw, success, warn } from "./reporter.js";

export interface ContainerStatus {
  name: string;
  status: string;
  health: string;
  ports: string;
  service: string;
  /** `com.sandbox.local.role` — `"setup"` marks a one-shot container. Empty when unlabelled. */
  role: string;
  /** Meaningful only once `status` is `exited`; compose reports 0 for live containers too. */
  exitCode: number;
}

/**
 * One label out of compose's `Labels` field, which flattens every label into a
 * single `k=v,k=v` string rather than an object.
 */
function labelValue(labels: unknown, key: string): string {
  if (typeof labels !== "string") return "";
  const m = new RegExp(`(?:^|,)${key.replace(/\./g, "\\.")}=([^,]*)`).exec(labels);
  return m ? m[1] : "";
}

/**
 * Resolve the path to a feature's workspace docker-compose.yml.
 *
 * Looks up the workspace via the `com.docker.compose.project.working_dir`
 * label on any container belonging to *feature*; falls back to
 * `resolveWorkspace(feature)` (cwd / env-based) when no container exists
 * yet. Returns `null` if neither source yields an existing file.
 */
function composeFile(feature: string): string | null {
  const workspace = workspaceForFeature(feature);
  if (workspace === null) {
    return null;
  }
  return path.join(workspace, "docker-compose.yml");
}

/** Return the workspace path for *feature*, or `null` if unresolvable. */
export function workspaceForFeature(feature: string): string | null {
  const labelWorkspace = workspaceFromContainerLabel(feature);
  if (
    labelWorkspace !== null &&
    isFile(path.join(labelWorkspace, "docker-compose.yml"))
  ) {
    return labelWorkspace;
  }
  let fallback: string;
  try {
    fallback = resolveWorkspace(feature);
  } catch {
    return labelWorkspace;
  }
  if (isFile(path.join(fallback, "docker-compose.yml"))) {
    return fallback;
  }
  return labelWorkspace;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Read the workspace path from a running container's compose label.
 *
 * docker compose stamps `com.docker.compose.project.working_dir` on every
 * container it creates, recording the directory the compose file was run
 * from. That directory is the feature's workspace.
 */
function workspaceFromContainerLabel(feature: string): string | null {
  let result;
  try {
    result = run(
      [
        "docker", "ps", "-a",
        "--filter", `label=com.sandbox.local.feature=${feature}`,
        "--format", '{{.Label "com.docker.compose.project.working_dir"}}',
      ],
      { capture: true, timeout: 10 },
    );
  } catch (err) {
    if (err instanceof ProcError) {
      return null; // missing docker binary, OS error, or timeout
    }
    throw err;
  }
  if (result.status !== 0) {
    return null;
  }
  for (const line of result.stdout.split("\n")) {
    const p = line.trim();
    if (p) {
      return p;
    }
  }
  return null;
}

/**
 * Run `docker compose -f <file> <args>`.
 *
 * When *capture* is true, capture stdout/stderr and return the result.
 * When *stream* is true, stream output directly to the terminal (for logs).
 *
 * Returns the completed process when *capture* is true, else `null`.
 */
function runCompose(
  feature: string,
  args: string[],
  {
    capture = false,
    stream = false,
    composePath = null,
  }: { capture?: boolean; stream?: boolean; composePath?: string | null } = {},
): RunResult | null {
  const cmd = composeCommand(feature, args, composePath);
  if (cmd === null) {
    return null;
  }

  try {
    if (stream) {
      // Stream output directly -- used for logs. Ctrl+C interrupts the
      // whole foreground process group, ending both us and the child.
      run(cmd, { stdio: "inherit" });
      return null;
    }
    return reportComposeOutcome(run(cmd, { capture, timeout: 300 }), capture);
  } catch (err) {
    return reportComposeFailure(err);
  }
}

/**
 * The cancellable sibling of {@link runCompose}.
 *
 * Every message the two produce comes from the three helpers they share, so the
 * async form cannot drift from the sync one it shadows -- which matters because
 * both spellings reach the same CLI output. No `stream` mode: a streaming tail
 * is {@link composeLogsStream}, which owns its own child.
 */
async function runComposeAsync(
  feature: string,
  args: string[],
  {
    capture = false,
    composePath = null,
    signal,
  }: { capture?: boolean; composePath?: string | null; signal?: AbortSignal } = {},
): Promise<RunResult | null> {
  const cmd = composeCommand(feature, args, composePath);
  if (cmd === null) {
    return null;
  }

  try {
    return reportComposeOutcome(await runAsync(cmd, { capture, timeout: 300, signal }), capture);
  } catch (err) {
    return reportComposeFailure(err);
  }
}

/**
 * Resolve the compose file and build the argv, announcing the run.
 *
 * `null` means there is nothing to run and the reason has already been
 * reported. Shared so the sync and async paths announce identically.
 */
function composeCommand(
  feature: string,
  args: string[],
  composePath: string | null,
): string[] | null {
  // Resolving costs a `docker ps`; a caller that already did it passes the path.
  composePath ??= composeFile(feature);
  if (composePath === null || !isFile(composePath)) {
    error(
      `No docker-compose.yml found for feature '${feature}'.\n` +
      `       Run 'sandbox init-workspace' (and 'sandbox up') from the ` +
      `feature's workspace first.`,
    );
    return null;
  }
  const cmd = ["docker", "compose", "-f", composePath, ...args];
  info(`Running: ${cmd.join(" ")}`);
  return cmd;
}

/** Report a completed compose run. Shared so both paths say the same thing. */
function reportComposeOutcome(result: RunResult, capture: boolean): RunResult | null {
  if (result.status !== 0) {
    const stderrText = capture ? result.stderr : "";
    error(`docker compose failed (exit ${result.status})`);
    if (stderrText) {
      raw(`${Colors.DIM}${stderrText.trim()}${Colors.RESET}\n`);
    }
  } else {
    if (capture) {
      return result;
    }
    success("docker compose completed successfully");
  }
  return capture ? result : null;
}

/**
 * Map a spawn failure onto `null`, or rethrow what is not ours.
 *
 * Abort joins ENOENT and timeout here because every caller treats all three the
 * same way -- as "did not run" -- and a cancelled teardown is not an error the
 * user needs a stack trace for.
 */
function reportComposeFailure(err: unknown): null {
  if (err instanceof ProcError && err.code === "ABORT_ERR") {
    warn("docker compose was cancelled");
    return null;
  }
  if (err instanceof ProcError && err.code === "ENOENT") {
    error(
      "docker compose not found. " +
      "Ensure Docker Desktop is installed and running.",
    );
    return null;
  }
  if (err instanceof ProcError && err.code === "ETIMEDOUT") {
    error("docker compose timed out after 5 minutes");
    return null;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start containers for *feature*.
 *
 * Equivalent to:
 *     docker compose -f <workspace>/docker-compose.yml up -d
 *
 * Returns true on success.
 */
export function composeUp(feature: string): boolean {
  const result = runCompose(
    feature,
    ["up", "-d", "--build", "--remove-orphans"],
    { capture: true },
  );
  if (result && result.status === 0) {
    success(`Containers for '${feature}' are up`);
    return true;
  }
  return false;
}

/**
 * Stop and remove containers for *feature*.
 *
 * When *removeVolumes* is true, also remove per-feature named Docker
 * volumes (node_modules, caches, etc.).
 *
 * Returns true on success.
 */
export function composeDown(
  feature: string,
  { removeVolumes = false }: { removeVolumes?: boolean } = {},
): boolean {
  // Checked here rather than left to runCompose's null: that null also covers
  // a missing docker binary and a timeout, which are failures, not "down".
  const composePath = composeFile(feature);
  if (composePath === null || !isFile(composePath)) {
    info(`No docker-compose.yml for '${feature}' -- nothing to tear down`);
    return true;
  }
  const args = ["down", "--remove-orphans"];
  if (removeVolumes) {
    args.push("--volumes");
  }
  const result = runCompose(feature, args, { capture: true, composePath });
  if (result === null || result.status !== 0) {
    return false;
  }
  let msg = `Containers for '${feature}' are down`;
  if (removeVolumes) {
    msg += " (volumes removed)";
  }
  success(msg);
  return true;
}

/** Cancellable {@link composeUp}. */
export async function composeUpAsync(feature: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runComposeAsync(
    feature,
    ["up", "-d", "--build", "--remove-orphans"],
    { capture: true, signal },
  );
  if (result && result.status === 0) {
    success(`Containers for '${feature}' are up`);
    return true;
  }
  return false;
}

/** Cancellable {@link composeDown}. */
export async function composeDownAsync(
  feature: string,
  { removeVolumes = false, signal }: { removeVolumes?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  // Mirrors composeDown exactly: that null also covers a missing docker binary,
  // a timeout and an abort, which are failures rather than "down".
  const composePath = composeFile(feature);
  if (composePath === null || !isFile(composePath)) {
    info(`No docker-compose.yml for '${feature}' -- nothing to tear down`);
    return true;
  }
  const args = ["down", "--remove-orphans"];
  if (removeVolumes) {
    args.push("--volumes");
  }
  const result = await runComposeAsync(feature, args, { capture: true, composePath, signal });
  if (result === null || result.status !== 0) {
    return false;
  }
  let msg = `Containers for '${feature}' are down`;
  if (removeVolumes) {
    msg += " (volumes removed)";
  }
  success(msg);
  return true;
}

/**
 * Stop (but do not remove) containers for *feature*.
 *
 * The slot and generated files are preserved so the feature can be
 * resumed with `sandbox restart <feature>` or `sandbox up <feature>`.
 *
 * Returns true on success.
 */
export function composeStop(feature: string): boolean {
  const result = runCompose(feature, ["stop"], { capture: true });
  if (result && result.status === 0) {
    success(`Containers for '${feature}' stopped (not removed)`);
    return true;
  }
  return false;
}

/**
 * Restart containers for *feature*.
 *
 * Returns true on success.
 */
export function composeRestart(feature: string): boolean {
  const result = runCompose(feature, ["restart"], { capture: true });
  if (result && result.status === 0) {
    success(`Containers for '${feature}' restarted`);
    return true;
  }
  return false;
}

/**
 * Tail docker compose logs for *feature*.
 *
 * If *service* is given, only show logs for that container.
 * Streams output until interrupted with Ctrl+C.
 */
export function composeLogs(feature: string, service?: string | null): void {
  const args = ["logs", "-f", "--tail", "100"];
  if (service) {
    args.push(service);
  }

  info(`Tailing logs for '${feature}'` + (service ? ` (${service})` : ""));
  raw(`${Colors.DIM}Press Ctrl+C to stop${Colors.RESET}\n`);
  runCompose(feature, args, { stream: true });
}

/**
 * Spawn `docker compose logs -f` for *feature*, streaming stdout and stderr to
 * *onData* and returning the child so the caller can kill it. `null` when the
 * feature has no compose file.
 *
 * The async sibling of {@link composeLogs}, which cannot be reused: it goes
 * through `proc.run` (spawnSync, `stdio: "inherit"`), so its output only ever
 * reaches the parent's own stdio and there is no stream to pipe elsewhere.
 *
 * `--ansi always` because compose prints ANSI only onto a TTY, and a piped
 * stream is not one — without it the per-service prefix colour that tells a
 * six-service tail apart is silently dropped. *env* exists for callers whose
 * PATH cannot find `docker`: a GUI-launched VS Code inherits none.
 */
export function composeLogsStream(
  feature: string,
  service: string | null,
  onData: (chunk: string) => void,
  env?: NodeJS.ProcessEnv,
): ChildProcess | null {
  const composePath = composeFile(feature);
  if (composePath === null || !isFile(composePath)) {
    return null;
  }

  const args = ["compose", "--ansi", "always", "-f", composePath, "logs", "-f", "--tail", "100"];
  if (service) {
    args.push(service);
  }

  const child = spawn("docker", args, { env });
  // Compose writes its own diagnostics ("no such service") to stderr; a caller
  // rendering one log surface wants those inline, not discarded.
  child.stdout.on("data", (d) => onData(d.toString()));
  child.stderr.on("data", (d) => onData(d.toString()));
  return child;
}

/**
 * Every container belonging to *feature*, stopped ones included. Empty when the
 * feature has no compose file or the `ps` call fails — indistinguishable from a
 * feature that has never been brought up, which is why callers treat both as
 * "nothing to report" rather than as an error.
 */
export function getContainerStatus(feature: string): ContainerStatus[] {
  // `-a`: without it compose lists only running containers, so a crashed service
  // silently vanishes and every caller's running/total tally reads as complete.
  const result = runCompose(feature, ["ps", "-a", "--format", "json"], { capture: true });
  if (!result || result.status !== 0) {
    return [];
  }

  const containers: ContainerStatus[] = [];
  for (const rawLine of result.stdout.trim().split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const data = JSON.parse(line);
      containers.push({
        name: data["Name"] ?? data["name"] ?? "unknown",
        status: data["State"] ?? data["state"] ?? "unknown",
        health: data["Health"] ?? data["health"] ?? "",
        ports: data["Ports"] ?? data["ports"] ?? "",
        service: data["Service"] ?? data["service"] ?? "",
        role: labelValue(data["Labels"] ?? data["labels"], "com.sandbox.local.role"),
        exitCode: data["ExitCode"] ?? data["exitCode"] ?? 0,
      });
    } catch {
      // Fallback: treat the line as plain text
      containers.push({
        name: line,
        status: "unknown",
        health: "",
        ports: "",
        service: "",
        role: "",
        exitCode: 0,
      });
    }
  }

  return containers;
}

/**
 * One-shot setup containers run once and exit by design — they have no
 * `restart` policy, unlike real services. Counting a finished one would make a
 * healthy feature read as "partial".
 *
 * Identified by the `com.sandbox.local.role=setup` label the compose template
 * stamps on every `setup_services` entry; the `-setup` suffix is the pre-label
 * fallback, since the label only lands on containers created after it was added
 * and workspaces that are already up must keep reading correctly until their
 * next recreate.
 */
export function isOneShotService(service: string, role: string | undefined): boolean {
  return role === "setup" || service.endsWith("-setup");
}
