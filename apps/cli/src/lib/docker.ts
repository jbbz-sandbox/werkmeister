/**
 * Docker Compose helpers for the developer sandbox.
 *
 * Wraps `docker compose` commands to manage per-feature container stacks.
 * As of Phase 3 each feature's compose file lives at
 * `<workspace>/docker-compose.yml` (the canonical location).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors, error, info, resolveWorkspace, success } from "./config.js";
import { ProcError, run, RunResult } from "sandbox-core/proc";

export interface ContainerStatus {
  name: string;
  status: string;
  health: string;
  ports: string;
  service: string;
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
  { capture = false, stream = false }: { capture?: boolean; stream?: boolean } = {},
): RunResult | null {
  const composePath = composeFile(feature);
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

  try {
    if (stream) {
      // Stream output directly -- used for logs. Ctrl+C interrupts the
      // whole foreground process group, ending both us and the child.
      run(cmd, { stdio: "inherit" });
      return null;
    }

    const result = run(cmd, { capture, timeout: 300 });
    if (result.status !== 0) {
      const stderrText = capture ? result.stderr : "";
      error(`docker compose failed (exit ${result.status})`);
      if (stderrText) {
        console.log(`${Colors.DIM}${stderrText.trim()}${Colors.RESET}`);
      }
    } else {
      if (capture) {
        return result;
      }
      success("docker compose completed successfully");
    }
    return capture ? result : null;
  } catch (err) {
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
  const args = ["down", "--remove-orphans"];
  if (removeVolumes) {
    args.push("--volumes");
  }
  const result = runCompose(feature, args, { capture: true });
  if (result && result.status === 0) {
    let msg = `Containers for '${feature}' are down`;
    if (removeVolumes) {
      msg += " (volumes removed)";
    }
    success(msg);
    return true;
  }
  // Even if the compose file is missing, we consider it "down"
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
  console.log(`${Colors.DIM}Press Ctrl+C to stop${Colors.RESET}`);
  runCompose(feature, args, { stream: true });
}

/**
 * Return the status of all containers for *feature*.
 *
 * Returns a list of dicts:
 *     [{"name": "...", "status": "running", "ports": "0.0.0.0:11100->3060/tcp"}, ...]
 */
export function getContainerStatus(feature: string): ContainerStatus[] {
  const result = runCompose(feature, ["ps", "--format", "json"], { capture: true });
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
      });
    } catch {
      // Fallback: treat the line as plain text
      containers.push({
        name: line,
        status: "unknown",
        health: "",
        ports: "",
        service: "",
      });
    }
  }

  return containers;
}
