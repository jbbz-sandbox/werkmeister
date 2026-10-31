/**
 * Docker Compose helpers for werkmeister.
 *
 * Wraps `docker compose` commands to manage per-feature container stacks.
 * Each feature's compose file lives at the workspace root under `COMPOSE_FILE`
 * (see compose_file.ts for the legacy name still read as a fallback).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { Colors } from "./colors.js";
import { COMPOSE_FILE, findWorkspaceCompose } from "./compose_file.js";
import { resolveWorkspace } from "./config.js";
import { containerLogs, docker, type ProjectContainer, projectContainers } from "./docker.js";
import { ProcError, type RunResult, run, runAsync } from "./proc.js";
import { error, info, passthrough, raw, success, warn } from "./reporter.js";
import { getSlot, LABEL_FEATURE, LEGACY_LABEL_FEATURE, labelOf } from "./slots.js";

export interface ContainerStatus {
  name: string;
  status: string;
  health: string;
  ports: string;
  service: string;
  /** `com.werkmeister.role` — `"setup"` marks a one-shot container. Empty when unlabelled. */
  role: string;
  /** Meaningful only once `status` is `exited`; compose reports 0 for live containers too. */
  exitCode: number;
}

/**
 * Resolve the path to a feature's workspace compose file.
 *
 * Looks up the workspace via the `com.docker.compose.project.working_dir`
 * label on any container belonging to *feature*; falls back to
 * `resolveWorkspace(feature)` (cwd / env-based) when no container exists
 * yet, provided that workspace's `.env` names *feature*. Returns `null` if
 * neither source yields an existing file.
 */
function composeFile(feature: string): string | null {
  const workspace = workspaceForFeature(feature);
  if (workspace === null) {
    return null;
  }
  return findWorkspaceCompose(workspace);
}

/** Return the workspace path for *feature*, or `null` if unresolvable. */
export function workspaceForFeature(feature: string): string | null {
  const labelWorkspace = workspaceFromContainerLabel(feature);
  if (labelWorkspace !== null && findWorkspaceCompose(labelWorkspace) !== null) {
    return labelWorkspace;
  }
  let fallback: string;
  try {
    fallback = resolveWorkspace(feature);
  } catch {
    return labelWorkspace;
  }
  // resolveWorkspace answers "the workspace cwd is in", not "this feature's" —
  // without the ownership check any feature resolves to the enclosing one (#101).
  if (findWorkspaceCompose(fallback) !== null && envNamesFeature(fallback, feature)) {
    return fallback;
  }
  return labelWorkspace;
}

/** True when *workspace*'s generated `.env` declares `FEATURE=` or `WERKMEISTER_FEATURE=` *feature*. */
function envNamesFeature(workspace: string, feature: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(workspace, ".env"), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    const m = /^\s*(?:WERKMEISTER_)?FEATURE=(.*)$/.exec(line);
    return m !== null && m[1].trim() === feature;
  });
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
  for (const label of [LABEL_FEATURE, LEGACY_LABEL_FEATURE]) {
    let result;
    try {
      result = run(
        [
          "docker",
          "ps",
          "-a",
          "--filter",
          `label=${label}=${feature}`,
          "--format",
          '{{.Label "com.docker.compose.project.working_dir"}}',
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
    const found = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * The one way to spell `docker compose` for a workspace's stack.
 *
 * `-p`, not just the file's `name:`: a workspace container's `.env` exports
 * COMPOSE_PROJECT_NAME=sandbox-<caller>, which outranks `name:` and pointed // name-check: ignore
 * every compose call at the caller's project (#225, the same leak #198 closed
 * for infra). Without *composePath* compose reads the file from cwd.
 */
export function workspaceComposeArgv(
  feature: string,
  args: string[],
  composePath?: string,
): string[] {
  return [
    "docker",
    "compose",
    ...(composePath ? ["-f", composePath] : []),
    "-p",
    fileProject(feature, composePath),
    ...args,
  ];
}

/** The compose project a feature gets from its next `up` on. */
export function projectName(feature: string): string {
  return `werkmeister-${feature}`;
}

/** Pre-SW-93 project: a workspace stays under it until its next `up`. SW-11 drops it. */
export function legacyProjectName(feature: string): string {
  return `sandbox-${feature}`; // name-check: ignore
}

/** The project *feature*'s containers are under now: the legacy one while it holds any. */
export async function liveProject(feature: string): Promise<string> {
  const legacy = legacyProjectName(feature);
  return (await projectContainers(legacy))?.length ? legacy : projectName(feature);
}

/**
 * The project the compose file names. A file generated before SW-93 still says
 * `sandbox-<feature>`, and `-p` must agree with it or compose would start a second // name-check: ignore
 * copy of the workspace beside the running one.
 */
function fileProject(feature: string, composePath?: string): string {
  try {
    const doc =
      composePath && (parseYaml(fs.readFileSync(composePath, "utf8")) as { name?: string });
    if (doc && typeof doc.name === "string") return doc.name;
  } catch {
    // no file yet: the new name
  }
  return projectName(feature);
}

/**
 * Take down a pre-SW-93 `sandbox-<feature>` project once the compose file names // name-check: ignore
 * another: its containers hold the container names the new project needs, and a
 * `down --volumes` of the new project skips volumes the old one created. SW-11 drops this.
 */
export function retireLegacyProject(
  feature: string,
  composePath: string,
  { removeVolumes = false }: { removeVolumes?: boolean } = {},
): void {
  const legacy = legacyProjectName(feature);
  if (fileProject(feature, composePath) === legacy) return;
  takeDownProject(legacy, `'${feature}''s pre-rename project`, { removeVolumes });
}

/** `docker compose down` a pre-rename *project* by its label, when it still holds anything. */
export function takeDownProject(
  project: string,
  what: string,
  { removeVolumes = false }: { removeVolumes?: boolean } = {},
): void {
  const label = `label=com.docker.compose.project=${project}`;
  try {
    const held = [["docker", "ps", "-aq", "--filter", label]];
    if (removeVolumes) held.push(["docker", "volume", "ls", "-q", "--filter", label]);
    if (!held.some((cmd) => run(cmd, { capture: true, timeout: 10 }).stdout.trim())) return;
    info(`Taking down ${what} ${project}`);
    const args = ["down", "--remove-orphans", ...(removeVolumes ? ["--volumes"] : [])];
    // From an empty dir: compose finds the project by label, and must not load the
    // new compose file under the old name.
    const result = run(["docker", "compose", "-p", project, ...args], {
      capture: true,
      cwd: os.tmpdir(),
      timeout: COMPOSE_TIMEOUT_S,
    });
    if (result.status !== 0) warn(`Could not take down ${project}: ${result.stderr.trim()}`);
  } catch (e) {
    warn(`Could not take down ${project}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const COMPOSE_TIMEOUT_S = 300;
// A cold `up` holds the whole setup install and build (queued behind the
// host-wide install slots and turbo-build lock) before it starts a service (SW-86).
const COMPOSE_UP_TIMEOUT_S = 20 * 60;

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
    return reportComposeOutcome(run(cmd, { capture, timeout: COMPOSE_TIMEOUT_S }), capture);
  } catch (err) {
    return reportComposeFailure(err, COMPOSE_TIMEOUT_S);
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
    timeout = COMPOSE_TIMEOUT_S,
  }: {
    capture?: boolean;
    composePath?: string | null;
    signal?: AbortSignal;
    timeout?: number;
  } = {},
): Promise<RunResult | null> {
  const cmd = composeCommand(feature, args, composePath);
  if (cmd === null) {
    return null;
  }

  try {
    return reportComposeOutcome(await runAsync(cmd, { capture, timeout, signal }), capture);
  } catch (err) {
    return reportComposeFailure(err, timeout);
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
      `No ${COMPOSE_FILE} found for feature '${feature}'.\n` +
        `       Run 'werkmeister workspace init' (and 'werkmeister feature up') from the ` +
        `feature's workspace first.`,
    );
    return null;
  }
  if (args.includes("up")) {
    ensureSharedVolumes(composePath);
  }
  if (args.includes("up") || args.includes("down")) {
    retireLegacyProject(feature, composePath, { removeVolumes: args.includes("--volumes") });
  }
  const cmd = workspaceComposeArgv(feature, args, composePath);
  info(`Running: ${cmd.join(" ")}`);
  return cmd;
}

/**
 * Create the shared (`^name`) volumes *composePath* mounts — only those, so a
 * workspace that uses no cache never creates one (SW-69).
 *
 * Generated compose marks them `external` so no feature's `down --volumes`
 * removes them, and compose will not start a project whose external volume is
 * missing. `docker volume create` leaves an existing volume as it is. A failure
 * only warns: compose's own error about the missing volume follows.
 */
export function ensureSharedVolumes(composePath: string): void {
  try {
    const doc = parseYaml(fs.readFileSync(composePath, "utf8")) as {
      volumes?: Record<string, { name?: string; external?: boolean } | null>;
    } | null;
    const external = Object.entries(doc?.volumes ?? {})
      .filter(([, v]) => v?.external === true)
      .map(([key, v]) => v?.name ?? key);
    for (const name of external) {
      const result = run(["docker", "volume", "create", name], { capture: true });
      if (result.status !== 0) {
        warn(`Could not create shared volume '${name}': ${result.stderr.trim()}`);
      }
    }
  } catch (e) {
    warn(`Could not create shared volumes: ${e instanceof Error ? e.message : String(e)}`);
  }
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
 *
 * Every caller passes `capture: true` (or, for composeLogs's non-TTY path,
 * conditionally captures) rather than inheriting stdio, so whatever the child
 * printed before dying only ever lives on the ProcError -- replay it here
 * before reporting the failure, or a timeout/cancel on a long-running compose
 * (e.g. a `logs -f` or a slow `up --build`) reports with no transcript at all.
 * `e.stdout`/`e.stderr` are empty when nothing was captured (ENOENT, or a
 * stream-mode caller with inherited stdio), so this is a no-op there.
 */
function reportComposeFailure(err: unknown, timeout: number): null {
  if (err instanceof ProcError) {
    if (err.stdout) raw(err.stdout);
    if (err.stderr) raw(err.stderr, "stderr");
  }
  if (err instanceof ProcError && err.code === "ABORT_ERR") {
    warn("docker compose was cancelled");
    return null;
  }
  if (err instanceof ProcError && err.code === "ENOENT") {
    error("docker compose not found. " + "Ensure Docker Desktop is installed and running.");
    return null;
  }
  if (err instanceof ProcError && err.code === "ETIMEDOUT") {
    error(`docker compose timed out after ${timeout / 60} minutes`);
    return null;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Plain `stop`/`down`/`logs` skip a container whose profile is off, e.g. one the PR gate started (SW-34). */
const ALL_PROFILES = ["--profile", "*"];

/**
 * Start containers for *feature*.
 *
 * Equivalent to:
 *     docker compose -f <workspace>/compose.yml up -d
 *
 * Returns true on success.
 */
export function composeUp(feature: string): boolean {
  const result = runCompose(feature, ["up", "-d", "--build", "--remove-orphans"], {
    capture: true,
  });
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
    info(`No ${COMPOSE_FILE} for '${feature}' -- nothing to tear down`);
    return true;
  }
  const args = [...ALL_PROFILES, "down", "--remove-orphans"];
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
  const result = await runComposeAsync(feature, ["up", "-d", "--build", "--remove-orphans"], {
    capture: true,
    signal,
    timeout: COMPOSE_UP_TIMEOUT_S,
  });
  if (result && result.status === 0) {
    success(`Containers for '${feature}' are up`);
    return true;
  }
  return false;
}

/**
 * Start one service and wait until it runs (healthy, when it has a healthcheck).
 *
 * Its setup service's `service_completed_successfully` holds the start until the
 * install finishes. An on-demand service starts without its profile enabled,
 * because it is named (SW-34).
 */
export async function composeUpServiceAsync(
  feature: string,
  service: string,
  composePath: string,
): Promise<boolean> {
  const result = await runComposeAsync(feature, ["up", "-d", "--wait", service], {
    capture: true,
    composePath,
    timeout: COMPOSE_UP_TIMEOUT_S,
  });
  return result !== null && result.status === 0;
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
    info(`No ${COMPOSE_FILE} for '${feature}' -- nothing to tear down`);
    return true;
  }
  const args = [...ALL_PROFILES, "down", "--remove-orphans"];
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
 * resumed with `werkmeister feature restart <feature>` or `werkmeister feature up <feature>`.
 *
 * Returns true on success.
 */
export async function composeStop(feature: string): Promise<boolean> {
  const err = await stopOrRestart("stop", await liveProject(feature));
  if (err) {
    error(err);
    return false;
  }
  success(`Containers for '${feature}' stopped (not removed)`);
  return true;
}

/**
 * Restart containers for *feature*.
 *
 * Returns true on success.
 */
export async function composeRestart(feature: string): Promise<boolean> {
  const err = await stopOrRestart("restart", await liveProject(feature));
  if (err) {
    error(err);
    return false;
  }
  success(`Containers for '${feature}' restarted`);
  return true;
}

/**
 * `compose stop` / `compose restart` for one project, on the Engine API (SW-60).
 *
 * Stop takes every live container, whatever its profile, as `--profile *` did;
 * restart takes stopped ones too, as compose does, except a finished setup
 * container, which would run the install again. Returns the message to report,
 * or null on success.
 */
export async function stopOrRestart(
  action: "stop" | "restart",
  project: string,
  service?: string,
): Promise<string | null> {
  const containers = await projectContainers(project, service, { all: action === "restart" });
  if (containers === null) return "docker not found / not running";
  const ordered = dependencyOrder(containers);
  if (action === "stop") ordered.reverse();
  const profiled = action === "restart" ? profiledServices(containers) : new Set<string>();
  for (const c of ordered) {
    const finishedSetup =
      c.state === "exited" && isOneShotService(c.service, labelOf(c.labels, "role"));
    // `compose restart` loads the default profiles only, so it never started
    // an on-demand container the PR gate had stopped (SW-34).
    const offProfile = c.state !== "running" && profiled.has(c.service);
    if (finishedSetup || offProfile) continue;
    try {
      await docker().getContainer(c.name)[action]();
    } catch (e) {
      // 304: it stopped between the list and the call, which is the goal.
      if ((e as { statusCode?: number }).statusCode === 304) continue;
      const daemon = (e as { json?: { message?: string } }).json?.message;
      return `docker ${action} ${c.name} failed: ${daemon ?? (e as Error).message}`;
    }
  }
  return null;
}

/** Services behind a compose profile, read from the files compose labels each container with. */
function profiledServices(containers: ProjectContainer[]): Set<string> {
  const files = containers[0]?.labels["com.docker.compose.project.config_files"]?.split(",") ?? [];
  const profiled = new Set<string>();
  for (const file of files) {
    try {
      const services: Record<string, { profiles?: string[] } | null> =
        parseYaml(fs.readFileSync(file, "utf8"))?.services ?? {};
      for (const [name, def] of Object.entries(services)) {
        if (def?.profiles?.length) profiled.add(name);
      }
    } catch {
      // ponytail: an unreadable file (workspace moved) reads as no profiles, so
      // a stopped on-demand container restarts too; warn here if that bites.
    }
  }
  return profiled;
}

/**
 * Dependencies before dependents, from the `com.docker.compose.depends_on`
 * label compose stamps on each container (`svc:condition:restart,…`).
 */
export function dependencyOrder(containers: ProjectContainer[]): ProjectContainer[] {
  const byService = new Map<string, ProjectContainer[]>();
  for (const c of containers) byService.set(c.service, [...(byService.get(c.service) ?? []), c]);
  const ordered: ProjectContainer[] = [];
  const seen = new Set<string>();
  const visit = (service: string) => {
    const group = byService.get(service);
    if (!group || seen.has(service)) return;
    seen.add(service); // before the deps, so a cycle ends instead of recursing
    for (const dep of (group[0].labels["com.docker.compose.depends_on"] ?? "").split(",")) {
      visit(dep.split(":")[0]);
    }
    ordered.push(...group);
  };
  for (const service of byService.keys()) visit(service);
  return ordered;
}

export interface ComposeLogsOptions {
  /** Stream until *signal* aborts (`-f`). Default true — the CLI's behaviour. */
  follow?: boolean;
  /** Lines of history to show. Default 100. */
  tail?: number;
  signal?: AbortSignal;
}

/**
 * Tail the logs of *feature*'s containers, as `docker compose logs` printed them.
 *
 * If *service* is given, only show logs for that container. With `follow`
 * (the default) this streams until *signal* aborts (Ctrl+C, for the CLI); with
 * `follow: false` it returns once every container's backlog is out, which is
 * what makes it usable as a request/response tool rather than a subscription.
 *
 * The slot guard lives here rather than in the caller so every consumer gets
 * told *why* a tail produced nothing.
 */
export async function composeLogs(
  feature: string,
  service?: string | null,
  { follow = true, tail = 100, signal }: ComposeLogsOptions = {},
): Promise<void> {
  if ((await getSlot(feature)) === null) {
    warn(`Feature '${feature}' is not running (no slot allocated)`);
    warn(`Start it with: werkmeister feature up ${feature}`);
    return;
  }

  info(`Tailing logs for '${feature}'` + (service ? ` (${service})` : ""));
  if (follow) {
    raw(`${Colors.DIM}Press Ctrl+C to stop${Colors.RESET}\n`);
  }

  // Coloured only onto a terminal, as compose's own auto-detect did: an
  // in-process caller's reporter (the MCP tool's) owns no TTY.
  const color = passthrough() && process.stdout.isTTY === true;
  await containerLogs(
    await liveProject(feature),
    service ?? null,
    { follow, tail, signal, color },
    (line, stream) => raw(`${line}\n`, stream),
  );
}

/** A running tail: `stop()` closes every container stream; `done` settles once they are closed. */
export interface LogTail {
  stop(): void;
  done: Promise<void>;
}

/**
 * Follow *feature*'s logs (last 100 lines, then live) into *onData*, for a
 * caller that renders them itself: the VS Code logs pane.
 *
 * Always coloured, since the pane is a terminal that renders ANSI. Over the
 * Engine API, so it needs no `docker` binary on PATH, which a VS Code launched
 * from the Dock does not have.
 */
export function composeLogsStream(
  feature: string,
  service: string | null,
  onData: (chunk: string) => void,
): LogTail {
  const controller = new AbortController();
  const done = liveProject(feature).then((project) =>
    containerLogs(
      project,
      service,
      { follow: true, tail: 100, signal: controller.signal, color: true },
      (line) => onData(`${line}\n`),
    ),
  );
  return { stop: () => controller.abort(), done };
}

/**
 * Every container belonging to *feature*, stopped ones included (`-a`: without
 * it a crashed service silently vanishes and every caller's running/total tally
 * reads as complete). Empty when the daemon can't be reached — indistinguishable
 * from a feature that has never been brought up, which is why callers treat both
 * as "nothing to report" rather than as an error.
 */
export async function getContainerStatus(feature: string): Promise<ContainerStatus[]> {
  const containers = (await projectContainers(await liveProject(feature))) ?? [];
  return containers.map((c) => ({
    name: c.name,
    status: c.state,
    health: c.health,
    ports: c.ports,
    service: c.service,
    role: labelOf(c.labels, "role"),
    exitCode: c.exitCode,
  }));
}

/**
 * One-shot setup containers run once and exit by design — they have no
 * `restart` policy, unlike real services. Counting a finished one would make a
 * healthy feature read as "partial".
 *
 * Identified by the `com.werkmeister.role=setup` label the compose template
 * stamps on every `setup_services` entry; the `-setup` suffix is the pre-label
 * fallback, since the label only lands on containers created after it was added
 * and workspaces that are already up must keep reading correctly until their
 * next recreate.
 */
export function isOneShotService(service: string, role: string | undefined): boolean {
  return role === "setup" || service.endsWith("-setup");
}
