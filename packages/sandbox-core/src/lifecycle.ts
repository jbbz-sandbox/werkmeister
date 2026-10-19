/**
 * The feature lifecycle — `up`/`down`/`stop`/`restart` — as callable functions.
 *
 * These are the sequences `apps/cli/src/commands/*` used to *be*. Splitting them
 * out is what lets a caller that is not a process — the dashboard, an MCP server
 * — drive a feature without a subprocess, which is the whole point of §5 of the
 * migration design.
 *
 * The convention, so the boundary is one rule and not four:
 *
 * - the feature is always an explicit argument; nothing here reads `process.cwd()`
 *   or `process.env.FEATURE`,
 * - a failure is a `SandboxError` with a code, never a `process.exit`,
 * - progress goes through the reporter (`info`/`warn`/`error`), but banners,
 *   tables and next-step hints do not — those are the CLI's rendering, and stay
 *   in the CLI,
 * - the return value is a plain object the caller can branch on.
 *
 * *feature* is a real feature throughout. `infra` is a CLI-level target that
 * routes to `werkmeister-core/infra` before reaching any of this — passing it here
 * finds no slot, which `stop`/`restart` reject as `NOT_RUNNING` and `down`
 * merely warns about. `sandbox up infra` is the one that does not even reach
 * `infra`: it means `sandbox connect`, which is still a command module, so that
 * branch stays in the CLI until row 5g moves it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isCaddyRunning, reloadCaddy, startCaddy } from "./caddy.js";
import { Colors } from "./colors.js";
import {
  // Both spellings: `up`/`down` take an AbortSignal and use the async pair;
  // `remove`/`clean` are not signal verbs (spec D4) and keep the sync ones.
  composeDown,
  composeDownAsync,
  composeRestart,
  composeStop,
  composeUp,
  composeUpAsync,
  getContainerStatus,
  workspaceForFeature,
} from "./compose.js";
import { COMPOSE_FILE, migrateWorkspaceCompose } from "./compose_file.js";
import { getVolumeBaseNames, loadPorts, loadServices } from "./config.js";
import { listVolumeNames, removeVolume } from "./docker.js";
import { dotDir } from "./dot_dir.js";
import { SandboxError } from "./errors.js";
import { loadFeatureRouters } from "./feature_routing.js";
import {
  generateCaddyfile,
  generateFeatureCompose,
  generateFeatureEnv,
  generateSupergraphConfig,
  isFeatureComposeStale,
  loadWorkspaceEnvVars,
  writeServiceSecretEnvs,
} from "./generate.js";
import { load as loadGlobalConfig } from "./global_config.js";
import { reconcileGraduating } from "./graduate.js";
import { ensurePortForwardsHealthy, waitForForwards } from "./k8s.js";
import { latestHandoff, type Note, openDecisions } from "./notes.js";
import { type RunResult, run } from "./proc.js";
import { info, raw, success, warn } from "./reporter.js";
import { getSecretsPath, loadSecrets, resolveSecrets } from "./secrets.js";
import {
  allocateSlot,
  getAllSlots,
  getPortRange,
  getServicePort,
  getSlot,
  releaseSlot,
} from "./slots.js";
import { strategyFor } from "./strategies/index.js";

/** Everything `sandbox up` computed, separated from how the CLI renders it. */
export interface UpResult {
  feature: string;
  slot: number;
  portRange: [number, number];
  /** The services this workspace runs locally; empty means all traffic goes to k8s. */
  localServices: string[];
  /** `https://<hostname>` for each local service Caddy terminates directly. */
  urls: string[];
  servicePorts: { service: string; port: number }[];
  /** The reserved slot was taken, so the compose files were rewritten for a new one. */
  regenerated: boolean;
  /** The compose file predates the service registry — warned about, not rewritten. */
  staleCompose: boolean;
  containersStarted: boolean;
  caddy: "reloaded" | "started";
}

/**
 * Bring *feature* up: allocate its slot, start its containers, and point the
 * proxy at them.
 *
 * *workspace* is passed in rather than resolved here: `resolveWorkspace` falls
 * back to the current directory, which is the caller's for an in-process caller
 * and so would silently point the dashboard at whatever it happened to be
 * running from. The CLI resolves it from argv and hands it over.
 *
 * Throws `NO_COMPOSE` when the workspace has no generated compose file,
 * `MISSING_SECRETS` when a secret this workspace's own services require is
 * absent, `SLOT_ALLOC` when no slot can be allocated, `FORWARDS_NEVER_READY`
 * when the forwards are restarted and their tunnels never reconnect, and
 * `COMPOSE_UP_FAILED` when `docker compose up` reports failure, and
 * `INSIDE_OWN_CONTAINER` before any of it when run inside *feature*'s own container.
 */
export async function up(
  feature: string,
  workspace: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<UpResult> {
  refuseInsideOwnContainer(feature, "up");
  migrateWorkspaceCompose(workspace);
  if (!fs.existsSync(path.join(workspace, COMPOSE_FILE))) {
    throw new SandboxError(
      `No ${COMPOSE_FILE} found in workspace: ${workspace}\n` +
        "       Run 'sandbox init-workspace' first to generate it.",
      "NO_COMPOSE",
    );
  }

  // Config first because the proxy generation needs it, then fail on a missing
  // secret before any slot state is mutated or any container starts.
  info("Loading configuration...");
  const servicesConfig = loadServices();
  const config = { services: servicesConfig, ports: loadPorts() };
  const localServices = readServicesFromWorkspace(workspace);
  requireSecrets(servicesConfig, localServices, workspace);
  // Unlike compose, these files are fully generated, so rewriting them on every
  // `up` loses no hand-edits and picks up a rotated secret without init-workspace.
  writeServiceSecretEnvs(workspace, localServices, servicesConfig);

  // Each strategy repairs its own layer: jit re-merges its hooks (a workspace
  // created before a hook-template change otherwise keeps the stale one), icm
  // strips any a pre-strategy `up` installed.
  strategyFor(workspace).refresh(workspace);

  info("Allocating feature slot...");
  const preferredSlot = readSlotFromWorkspace(workspace);
  let slot: number;
  try {
    slot = await allocateSlot(feature, localServices, preferredSlot);
  } catch (e) {
    // Rewrapped rather than left to propagate: allocation reports failure as a
    // plain Error, whose message already carries the stale-lock recovery
    // guidance, and `main.ts` prints a bare Error as `Error: <msg>` instead of
    // the `[err] <msg>` this site has always produced.
    throw new SandboxError(e instanceof Error ? e.message : String(e), "SLOT_ALLOC");
  }

  const [portStart, portEnd] = getPortRange(slot);
  info(`Slot ${slot} -> port range ${portStart}-${portEnd}`);

  const regenerated = preferredSlot !== null && slot !== preferredSlot;
  let staleCompose = false;
  if (regenerated) {
    warn(`Slot changed (${preferredSlot} → ${slot}) — regenerating compose...`);
    generateFeatureCompose(feature, slot, localServices, config, workspace, "sandbox up");
    generateFeatureEnv(feature, slot, localServices, config, workspace);
  } else if (isFeatureComposeStale(feature, slot, localServices, config, workspace)) {
    // Warn rather than regenerate: `up` starting to rewrite workspace files
    // would silently discard hand-edits to the generated compose.
    staleCompose = true;
    warn(
      `${COMPOSE_FILE} predates the current service registry — ` +
        "run 'sandbox init-workspace' in the workspace to regenerate it.",
    );
  }
  // Every `up`, not just on a slot change: the file is fully generated and
  // nothing reads it, and with no subgraph this removes a stale copy (#120).
  generateSupergraphConfig(feature, slot, localServices, config, workspace);

  // Unprefixed because it always has been — `raw` is what keeps the CLI's bytes
  // identical for a line that sits mid-sequence and so cannot move to the
  // command's summary block.
  raw(
    `\n  ${Colors.CYAN}Local services: ` +
      `${Colors.BOLD}${localServices.length ? localServices.join(", ") : "(none -- all via k8s)"}` +
      `${Colors.RESET}\n\n`,
  );

  info("Checking k8s port-forwards...");
  // A restart returns when the container runs, not when its tunnels carry
  // traffic. Starting containers in that window is what produces a compose
  // dependency failure that never mentions a port-forward — so wait, and only
  // after a restart, leaving the healthy path costing exactly what it did.
  //
  // The two failures are deliberately not the same. A restart that *fails* may
  // just mean this machine runs no cluster, and a feature needing nothing from
  // one has always come up regardless, so it stays non-fatal and already
  // reported itself. Tunnels that never return after a successful restart mean
  // forwards this machine does run are broken; `waitForForwards` throws, which
  // says so far better than the compose error it replaces.
  if (ensurePortForwardsHealthy() === "restarted") {
    await waitForForwards();
  }

  let containersStarted = false;
  if (localServices.length) {
    info("Starting containers...");
    if (!(await composeUpAsync(feature, signal))) {
      throw new SandboxError(
        "Failed to start containers. Check docker compose output above.",
        "COMPOSE_UP_FAILED",
      );
    }
    containersStarted = true;
  } else {
    info("No local services to start -- routing entirely to k8s");
  }

  info("Configuring reverse proxy...");
  await generateCaddyfile(null, config);

  let caddy: "reloaded" | "started";
  if (isCaddyRunning()) {
    await reloadCaddy();
    caddy = "reloaded";
  } else {
    info("Caddy not running -- starting it...");
    startCaddy();
    caddy = "started";
  }

  // Derivations, not rendering: they exist only inside the summary's
  // `console.log` today, which is why an in-process caller could never get at
  // the URL a feature is reachable on.
  const routers = loadFeatureRouters(servicesConfig);
  const urls = localServices
    .map((s) => routers[s]?.hostname)
    .filter((h): h is string => Boolean(h))
    .map((h) => `https://${h}`);
  const servicePorts = [...localServices].sort().map((service) => {
    const svcDef = servicesConfig[service] ?? {};
    const offset = typeof svcDef === "object" && svcDef !== null ? (svcDef["port_offset"] ?? 0) : 0;
    return { service, port: getServicePort(slot, offset) };
  });

  return {
    feature,
    slot,
    portRange: [portStart, portEnd],
    localServices,
    urls,
    servicePorts,
    regenerated,
    staleCompose,
    containersStarted,
    caddy,
  };
}

// ponytail: two hand-rolled parsers over the same file, because `loadDotenv`
// walks up from a start directory and these must read exactly this workspace's
// .env. Collapse them into one read if a third key is ever needed.

/** Read SANDBOX_SLOT from <workspace>/.env. */
function readSlotFromWorkspace(workspace: string): number | null {
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile()) {
    return null;
  }
  for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SANDBOX_SLOT=")) {
      const value = line.slice("SANDBOX_SLOT=".length).trim();
      const n = Number(value);
      if (value !== "" && Number.isInteger(n)) {
        return n;
      }
    }
  }
  return null;
}

/** Read the SERVICES list from <workspace>/.env (written by init-workspace). */
export function readServicesFromWorkspace(workspace: string): string[] {
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile()) {
    return [];
  }
  for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SERVICES=")) {
      return line
        .slice("SERVICES=".length)
        .trim()
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
    }
  }
  return [];
}

/**
 * Fail before slot allocation or `composeUp` when a secret key required by this
 * workspace's own services is missing or empty, so it surfaces as a clear,
 * value-free message instead of an opaque runtime error deep in container logs.
 */
function requireSecrets(
  servicesConfig: Record<string, any>,
  localServices: string[],
  workspace: string,
): void {
  const secretsPath = getSecretsPath();
  const { missing } = resolveSecrets(
    loadSecrets(secretsPath),
    servicesConfig,
    localServices,
    loadWorkspaceEnvVars(workspace),
  );
  if (missing.length) {
    throw new SandboxError(
      `Missing required secret(s) in ${secretsPath}: ` +
        `${missing.join(", ")}\n` +
        `       Run \`sandbox setup\` to write a template to ${secretsPath}, ` +
        "then fill in the missing values (or pin them under `env_vars:` in " +
        ".sandbox/workspace.yml).",
      "MISSING_SECRETS",
    );
  }
}

/**
 * True when this process runs inside *feature*'s own container: every
 * workspace container exports `SANDBOX_FEATURE`, and Docker writes
 * `/.dockerenv`. Reads the caller's env about *itself*, not to pick a feature.
 */
export function insideOwnContainer(
  feature: string,
  env: NodeJS.ProcessEnv = process.env,
  dockerenv = "/.dockerenv",
): boolean {
  return (env.WERKMEISTER_FEATURE ?? env.SANDBOX_FEATURE) === feature && fs.existsSync(dockerenv);
}

/**
 * Compose recreates, stops or removes the container this process runs in, so
 * the verb dies mid-sequence with exit 137 — `down` before it releases the
 * slot (#198). Another feature's containers are safe to drive from here.
 */
function refuseInsideOwnContainer(feature: string, verb: string): void {
  if (insideOwnContainer(feature)) {
    throw new SandboxError(
      `'sandbox ${verb}' is running inside ${feature}'s own container, which it would ` +
        "recreate or stop and so kill itself.\n" +
        `       Run it from the host: cd to the workspace and run 'sandbox ${verb}'.`,
      "INSIDE_OWN_CONTAINER",
    );
  }
}

/** A feature that was running, and the slot it keeps while stopped. */
export interface StopResult {
  feature: string;
  slot: number;
}

/** What `sandbox stop --if-idle` knows when a SessionEnd hook runs it (#231). */
export interface IdleStopInput {
  /** FEATURE from the workspace `.env`. */
  feature: string | undefined;
  /** The directory holding that `.env`. */
  workspaceRoot: string;
  /** The ending session's `session_id` from the hook's stdin. */
  sessionId: string | null;
  /** The hook's stdin `reason`. */
  reason: string | null;
  /** `CLAUDE_CODE_ENTRYPOINT` (undocumented; `sdk-*` for `claude -p` and SDK runs). */
  entrypoint: string | null;
  sessionsDir?: string;
}

// `/clear` and `/resume` end a session but the same process carries on in the next one.
const _CONTINUING_REASONS = new Set(["clear", "resume"]);

/** A running Claude Code session, as its `~/.claude/sessions/` file describes it. */
export interface LiveSession {
  pid: number;
  sessionId: string | null;
  /** `busy` / `idle`; null when the file has no status. */
  status: string | null;
  /** Epoch ms of the last status change, or null. */
  statusUpdatedAt: number | null;
}

/**
 * The Claude Code sessions whose cwd is in *workspaceRoot*. Claude Code keeps one
 * file per running session in `~/.claude/sessions/` "to detect concurrent
 * sessions"; its fields are undocumented, so an unreadable file counts as no
 * session, and a crash leftover is dropped by the pid check.
 */
export function liveSessions(
  workspaceRoot: string,
  sessionsDir = path.join(os.homedir(), ".claude", "sessions"),
): LiveSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const sessions: LiveSession[] = [];
  for (const name of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"));
      const cwd = String(s.cwd ?? "");
      const inWorkspace = cwd === workspaceRoot || cwd.startsWith(workspaceRoot + path.sep);
      if (!inWorkspace || !Number.isInteger(s.pid)) continue;
      process.kill(s.pid, 0);
      sessions.push({
        pid: s.pid,
        sessionId: typeof s.sessionId === "string" ? s.sessionId : null,
        status: typeof s.status === "string" ? s.status : null,
        statusUpdatedAt: Number.isFinite(s.statusUpdatedAt) ? s.statusUpdatedAt : null,
      });
    } catch {
      // unparseable, or the pid is gone
    }
  }
  return sessions;
}

/** Pids of the sessions in *workspaceRoot* other than *sessionId*. */
export function otherLiveSessions(
  workspaceRoot: string,
  sessionId: string | null,
  sessionsDir?: string,
): number[] {
  return liveSessions(workspaceRoot, sessionsDir)
    .filter((s) => s.sessionId !== sessionId)
    .map((s) => s.pid);
}

/** A feature with running containers, from their compose labels. */
export interface RunningFeature {
  feature: string;
  workspace: string;
  /** Each running container's `State.StartedAt`, epoch ms. */
  startedAt: number[];
}

export interface IdleInput {
  minutes: number;
  now: number;
  running: RunningFeature[];
  sessions: (workspace: string) => Pick<LiveSession, "status" | "statusUpdatedAt">[];
  /** Epoch ms the gate last ran `docker exec` in *workspace*, or null. */
  lastExec: (workspace: string) => number | null;
}

/** Why a running feature is not idle, or null when it is. */
function busyReason(f: RunningFeature, input: IdleInput, cutoff: number): string | null {
  // An open session that has sat idle past the cutoff does not count (SW-39 D3).
  const active = input
    .sessions(f.workspace)
    .some((s) => s.status !== "idle" || (s.statusUpdatedAt ?? Infinity) > cutoff);
  if (active) return "session active";
  if (f.startedAt.some((t) => t > cutoff)) return `started < ${input.minutes} min ago`;
  if ((input.lastExec(f.workspace) ?? 0) > cutoff) return `gate ran < ${input.minutes} min ago`;
  return null;
}

/** The features nothing has used for `input.minutes` (SW-39). Never `infra`. */
export function idleFeatures(input: IdleInput): string[] {
  const cutoff = input.now - input.minutes * 60_000;
  return input.running
    .filter((f) => f.feature !== "infra" && !busyReason(f, input, cutoff))
    .map((f) => f.feature);
}

/** `overrides.idle_stop_minutes` from the global config; 30 when unset, 0 turns the reaper off. */
export function idleStopMinutes(): number {
  const v = (loadGlobalConfig()["overrides"] as Record<string, unknown> | undefined)?.[
    "idle_stop_minutes"
  ];
  return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 30;
}

/** The gate's `docker exec` marker (SW-39), touched by `runGate`. */
export function lastExecMarker(workspaceRoot: string): string {
  return path.join(dotDir(workspaceRoot), "last-exec");
}

function mtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

const LABEL_FEATURE = "com.sandbox.local.feature";
const LABEL_WORKDIR = "com.docker.compose.project.working_dir";

/** Running feature containers grouped by feature; null when docker cannot be read. */
function runningFeatures(runCmd: (cmd: string[]) => RunResult): RunningFeature[] | null {
  try {
    const ids = runCmd(["docker", "ps", "-q", "--filter", `label=${LABEL_FEATURE}`]);
    if (ids.status !== 0) return null;
    const list = ids.stdout.split("\n").filter(Boolean);
    if (!list.length) return [];
    const fmt = `{{index .Config.Labels "${LABEL_FEATURE}"}}\t{{index .Config.Labels "${LABEL_WORKDIR}"}}\t{{.State.StartedAt}}`;
    const inspect = runCmd(["docker", "inspect", "--format", fmt, ...list]);
    if (inspect.status !== 0) return null;
    const byFeature = new Map<string, RunningFeature>();
    for (const line of inspect.stdout.split("\n").filter(Boolean)) {
      const [feature, workspace, started] = line.split("\t");
      if (!feature || !workspace) continue;
      const f = byFeature.get(feature) ?? { feature, workspace, startedAt: [] };
      f.startedAt.push(Date.parse(started));
      byFeature.set(feature, f);
    }
    return [...byFeature.values()];
  } catch {
    return null; // no docker binary, or it timed out
  }
}

export interface StopIdleOptions {
  /** Only this feature. */
  only?: string;
  now?: number;
  sessionsDir?: string;
  run?: (cmd: string[]) => RunResult;
  stop?: (feature: string) => Promise<unknown>;
}

/**
 * `werkmeister stop --idle <minutes>` and the `watchPrs` reaper (SW-39): stop each
 * feature nothing has used for *minutes*. One line per running feature; never
 * throws, so a watch pass is never failed by it.
 */
export async function stopIdle(
  minutes: number,
  opts: StopIdleOptions = {},
): Promise<{ ok: boolean; lines: string[] }> {
  const runCmd = opts.run ?? ((cmd) => run(cmd, { capture: true, timeout: 20 }));
  const found = runningFeatures(runCmd);
  if (!found) return { ok: true, lines: ["docker unavailable — nothing reaped"] };
  const running = found.filter((f) => !opts.only || f.feature === opts.only);
  if (!running.length) return { ok: true, lines: ["no running feature containers"] };
  const input: IdleInput = {
    minutes,
    now: opts.now ?? Date.now(),
    running,
    sessions: (ws) => liveSessions(ws, opts.sessionsDir),
    lastExec: (ws) => mtimeMs(lastExecMarker(ws)),
  };
  const cutoff = input.now - minutes * 60_000;
  const lines: string[] = [];
  let ok = true;
  for (const f of running) {
    const why =
      f.feature === "infra"
        ? "shared infra"
        : insideOwnContainer(f.feature)
          ? "running inside its own container"
          : busyReason(f, input, cutoff);
    if (why) {
      lines.push(`${f.feature}: kept (${why})`);
      continue;
    }
    try {
      await (opts.stop ?? stop)(f.feature);
      lines.push(`${f.feature}: stopped (idle ≥ ${minutes} min)`);
    } catch (e) {
      ok = false;
      lines.push(`${f.feature}: stop failed — ${(e as Error).message}`);
    }
  }
  return { ok, lines };
}

/**
 * The feature `stop --if-idle` should stop, or null to leave it running. Never
 * `infra`: it is shared by every workspace.
 */
export function idleStopFeature(input: IdleStopInput): string | null {
  const { feature, workspaceRoot, sessionId, reason, entrypoint, sessionsDir } = input;
  if (!feature || feature === "infra") return null;
  if (reason && _CONTINUING_REASONS.has(reason)) return null;
  // A headless turn ends its "session" every turn; the next turn needs the containers.
  if (entrypoint?.startsWith("sdk")) return null;
  if (otherLiveSessions(workspaceRoot, sessionId, sessionsDir).length) return null;
  return feature;
}

/** A feature that was running, and the slot its restarted containers reuse. */
export interface RestartResult {
  feature: string;
  slot: number;
}

/**
 * Stop *feature*'s containers, leaving them and its slot in place so
 * `restart`/`up` can resume it.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and
 * `COMPOSE_STOP_FAILED` when `docker compose stop` reports failure.
 */
export async function stop(feature: string): Promise<StopResult> {
  refuseInsideOwnContainer(feature, "stop");
  const slot = await requireSlot(feature);

  info(`Stopping containers for '${feature}' (slot ${slot})...`);
  if (!composeStop(feature)) {
    throw new SandboxError(`Failed to stop containers for '${feature}'`, "COMPOSE_STOP_FAILED");
  }

  return { feature, slot };
}

/**
 * Restart *feature*'s containers in place.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and
 * `COMPOSE_RESTART_FAILED` when `docker compose restart` reports failure.
 */
export async function restart(feature: string): Promise<RestartResult> {
  refuseInsideOwnContainer(feature, "restart");
  const slot = await requireSlot(feature);

  info(`Restarting containers for '${feature}' (slot ${slot})...`);
  if (!composeRestart(feature)) {
    throw new SandboxError(
      `Failed to restart containers for '${feature}'`,
      "COMPOSE_RESTART_FAILED",
    );
  }

  return { feature, slot };
}

/** A feature that has been torn down, and the slot it gave back. */
export interface DownResult {
  feature: string;
  /** null when the feature held no slot — torn down anyway; see `down`. */
  slot: number | null;
}

/**
 * Tear *feature* down: leave its k8s intercepts, remove its containers, and
 * release its slot.
 *
 * Unlike `stop`/`restart`, a missing slot is not an error — a half-torn-down
 * feature still has containers and generated files worth removing, so this
 * warns and cleans up anyway, and reports the slot as null.
 *
 * Does not touch the reverse proxy: `sandbox down --all-features` tears down N
 * features and reloads once, so the reload is `reloadProxy`, sequenced by the
 * caller. Does not read or print workspace notes either — that is a TTY prompt
 * loop, which §11 of the migration design keeps out of the library.
 */
export async function down(
  feature: string,
  { removeVolumes = false, signal }: { removeVolumes?: boolean; signal?: AbortSignal } = {},
): Promise<DownResult> {
  refuseInsideOwnContainer(feature, "down");
  // Best-effort, and before composeDown: leaveFeatureIntercepts resolves the
  // workspace from compose labels on the still-running containers.
  try {
    const { leaveFeatureIntercepts } = await import("./telepresence.js");
    const left = leaveFeatureIntercepts(feature);
    if (left.length) {
      info(`Left k8s intercept(s): ${left.join(", ")}`);
    }
  } catch (exc) {
    // teardown must never block on telepresence
    warn(`Could not clean up k8s intercepts: ${exc instanceof Error ? exc.message : String(exc)}`);
  }

  const slot = await getSlot(feature);
  if (slot === null) {
    warn(`Feature '${feature}' does not have an allocated slot`);
    warn("It may already be stopped. Cleaning up anyway...");
  }

  info("Stopping containers...");
  if (removeVolumes) {
    info("Per-feature Docker volumes will be removed");
  }
  // A failed teardown still releases the slot rather than stranding it, but
  // it is said out loud: the caller's summary otherwise reads as success.
  if (!(await composeDownAsync(feature, { removeVolumes, signal }))) {
    warn(`Containers for '${feature}' may still exist -- see the docker compose output above`);
  }

  info("Releasing feature slot...");
  releaseSlot(feature);

  return { feature, slot };
}

/** A service dropped back to k8s, and what the feature still runs locally. */
export interface RemoveResult {
  feature: string;
  removed: string;
  /** The feature's surviving local services, sorted. */
  remaining: string[];
  /** True when nothing local was left, so the containers were stopped rather than restarted. */
  containersStopped: boolean;
  proxyReloaded: boolean;
}

/**
 * Drop *service* from *feature*'s local services so it falls back to k8s:
 * regenerate the three generated workspace files, restart (or stop) the
 * containers, and re-point the proxy.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and `NOT_LOCAL` when
 * *service* is not one it runs locally. The second replaces an early return, so
 * the CLI catches it to print the same warning and local-services line it
 * always did — which is why the message carries no list: that line is layout.
 */
export async function removeService(feature: string, service: string): Promise<RemoveResult> {
  const config = { services: loadServices(), ports: loadPorts() };

  const slot = await requireSlot(feature);
  const remaining = [...((await getAllSlots())[feature]?.services ?? [])];

  if (!remaining.includes(service)) {
    throw new SandboxError(
      `Service '${service}' is not running locally for '${feature}'`,
      "NOT_LOCAL",
    );
  }

  remaining.splice(remaining.indexOf(service), 1);
  info(`Removed '${service}' from local services -- will fall back to k8s`);

  info("Regenerating configuration files...");
  generateFeatureCompose(feature, slot, remaining, config);
  generateFeatureEnv(feature, slot, remaining, config);
  generateSupergraphConfig(feature, slot, remaining, config);

  // Restarting is what removes the departing service's container; with nothing
  // left to run there is no container to keep, so the whole project goes down.
  let containersStopped = false;
  if (remaining.length) {
    info("Restarting containers...");
    composeUp(feature);
  } else {
    info("No local services remaining -- containers will be stopped");
    containersStopped = true;
    if (!composeDown(feature)) {
      warn(`Containers for '${feature}' may still exist -- see the docker compose output above`);
    }
  }

  info("Updating reverse proxy...");
  await generateCaddyfile(null, config);
  let proxyReloaded = false;
  if (isCaddyRunning()) {
    await reloadCaddy();
    proxyReloaded = true;
  }

  return {
    feature,
    removed: service,
    remaining: [...remaining].sort(),
    containersStopped,
    proxyReloaded,
  };
}

/** What the regenerated Caddyfile now routes, and whether Caddy took it. */
export interface ProxyReloadResult {
  /** The features written into the Caddyfile, sorted by name. */
  features: { feature: string; slot: number; services: string[] }[];
  /** Caddy was down and `start` was asked for, so it was started rather than reloaded. */
  started: boolean;
  /** False when Caddy rejected the config, or failed to start. */
  ok: boolean;
}

/**
 * Regenerate the Caddyfile from the active features and hand it to Caddy.
 *
 * Separate from `down` so a multi-feature teardown pays for one reload rather
 * than one per feature. `up` reloads inline instead because it may also have to
 * *start* Caddy, which is part of bringing a feature up.
 *
 * `start` selects the whole `sandbox proxy-reload` spelling, not just the
 * start-if-down fallback: that command has always used different progress
 * wording and listed the features it wrote, and teardown's three callers
 * (`commands/down.ts` twice, `sandbox.ts` twice) print neither. Defaulting it
 * to false is what keeps their output where it was — and stops a teardown
 * starting a proxy nobody asked for.
 */
/**
 * The four side effects `reloadProxy` performs, injectable so a test can assert
 * the sequence without writing a real Caddyfile or bouncing a live Caddy.
 *
 * Same shape and reason as `telepresence.ts`'s `Runner`: a trailing parameter
 * defaulted to the real thing, so no caller passes it and none has to know it
 * exists. It is deliberately the *whole* boundary rather than a caddy runner
 * alone — `getAllSlots` reads Docker container labels, so faking the proxy half
 * and not the slot half would leave the test needing a real daemon anyway.
 */
export interface ProxyOps {
  /** Returns the written path; `reloadProxy` ignores it. */
  generate: () => Promise<unknown>;
  slots: () => Promise<Record<string, { slot: number; services: string[] }>>;
  running: () => boolean;
  reload: () => Promise<boolean>;
  start: () => boolean;
}

// Wrapped rather than referenced: a bare `slots: getAllSlots` reads the imported
// binding when this module is evaluated, which throws under a partial `vi.mock`
// of `werkmeister-core/slots` that does not name `getAllSlots` — two CLI tests do
// exactly that, and would fail to load. The arrows resolve at call time.
const REAL_PROXY_OPS: ProxyOps = {
  generate: () => generateCaddyfile(),
  slots: () => getAllSlots(),
  running: () => isCaddyRunning(),
  reload: () => reloadCaddy(),
  start: () => startCaddy(),
};

export async function reloadProxy(
  { start = false }: { start?: boolean } = {},
  ops: ProxyOps = REAL_PROXY_OPS,
): Promise<ProxyReloadResult> {
  info(start ? "Regenerating Caddyfile..." : "Updating reverse proxy configuration...");
  await ops.generate();

  const allFeatures = await ops.slots();
  const features = Object.keys(allFeatures)
    .sort()
    .map((feature) => ({
      feature,
      slot: allFeatures[feature].slot,
      services: allFeatures[feature].services,
    }));

  // Emitted here rather than returned-and-rendered because the block sits
  // between the generate and the reload, so it cannot move to the command's
  // summary block — the same reason `up`'s "Local services" line uses `raw`.
  if (start) {
    if (!features.length) {
      info("No active features in Caddyfile");
    } else {
      raw(`\n  ${Colors.CYAN}Features in Caddyfile:${Colors.RESET}\n`);
      for (const { feature, slot, services } of features) {
        const svcStr = services.length ? services.join(", ") : "(no local services)";
        raw(`    ${Colors.GREEN}*${Colors.RESET} ${feature} (slot ${slot}): ${svcStr}\n`);
      }
      raw("\n");
    }
  }

  let started = false;
  let ok = true;
  if (ops.running()) {
    if (start) {
      info("Reloading Caddy...");
    }
    ok = await ops.reload();
  } else if (start) {
    warn("Caddy is not running -- starting it...");
    ok = ops.start();
    started = true;
  } else {
    info("Caddy is not running -- skipping reload");
  }

  return { features, started, ok };
}

/**
 * Volume base names declared by the service registry, longest first.
 *
 * Longest-first matters for {@link featureFromVolume}: a per-feature volume is
 * named `<feature>-<base>` with no prefix to anchor on, so when one base name
 * ends with another ("cache" and "turbo-cache") the shorter one would otherwise
 * match first and leave part of the base in the extracted feature name.
 *
 * A registry that cannot be read yields `[]`, which classifies nothing as a
 * sandbox volume — volume cleanup is skipped rather than guessing at names.
 */
export function volumeBaseNames(): string[] {
  let bases: string[];
  try {
    bases = getVolumeBaseNames();
  } catch (e) {
    warn(
      `Could not read the service registry (${e instanceof Error ? e.message : String(e)}) -- ` +
        "skipping Docker volume cleanup",
    );
    return [];
  }
  return bases.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Every Docker volume name that looks like a sandbox per-feature volume.
 *
 * They follow `<feature>-<volume_base_name>`, identified by checking against the
 * base names the service registry declares.
 */
async function listSandboxVolumes(baseNames: string[]): Promise<string[]> {
  if (!baseNames.length) {
    return [];
  }

  const allVolumes = await listVolumeNames();
  if (allVolumes === null) {
    return [];
  }

  const sandboxVolumes: string[] = [];
  for (const vol of allVolumes) {
    for (const base of baseNames) {
      if (vol.endsWith(`-${base}`)) {
        sandboxVolumes.push(vol);
        break;
      }
    }
  }
  return sandboxVolumes.sort();
}

/**
 * The feature name prefix of a per-feature volume, or null if it is not one.
 *
 * *baseNames* must be longest-first — see {@link volumeBaseNames}.
 */
export function featureFromVolume(volName: string, baseNames: string[]): string | null {
  for (const base of baseNames) {
    const suffix = `-${base}`;
    if (volName.endsWith(suffix)) {
      return volName.slice(0, volName.length - suffix.length);
    }
  }
  return null;
}

/** What a sweep found: the state it read, before anything it did about it. */
export interface CleanPlan {
  /** Features holding a slot when the sweep started, sorted. */
  activeFeatures: string[];
  /** Per-feature volumes kept because their feature is still up, sorted. */
  activeVolumes: string[];
  /** Per-feature volumes whose feature is gone, sorted. */
  orphanedVolumes: string[];
  /** Features holding a slot with neither a running container nor a compose file. */
  staleSlots: string[];
}

/** What a sweep found, and what it then actually removed. */
export interface CleanResult extends CleanPlan {
  removedVolumes: string[];
  releasedSlots: string[];
}

/**
 * Split *volumes* into the ones whose feature still holds a slot and the ones
 * whose feature is gone — the single decision that separates "kept" from
 * "deleted" in a sweep.
 *
 * Pulled out of {@link runClean} because it is the only part of that traversal
 * worth asserting and the only part that can be asserted without a Docker
 * daemon: everything around it is reads and progress output. A volume whose
 * name matches no base name has no feature, so it is not ours and is never
 * classified active.
 */
export function classifyVolumes(
  volumes: string[],
  baseNames: string[],
  live: Set<string>,
): { activeVolumes: string[]; orphanedVolumes: string[] } {
  const activeVolumes: string[] = [];
  const orphanedVolumes: string[] = [];
  for (const vol of volumes) {
    const feature = featureFromVolume(vol, baseNames);
    (feature && live.has(feature) ? activeVolumes : orphanedVolumes).push(vol);
  }
  return { activeVolumes, orphanedVolumes };
}

/**
 * What `runClean` would remove, without removing it.
 *
 * A dry run *is* the plan — the two share one traversal because the ordering of
 * the progress they report is the CLI's output contract — so this is the safe
 * spelling of {@link runClean}, not a second implementation of it.
 */
export async function planClean(opts: { all?: boolean } = {}): Promise<CleanPlan> {
  return runClean({ ...opts, dryRun: true });
}

/**
 * Sweep orphaned per-feature Docker volumes and stale slot entries.
 *
 * With *all*, active features are torn down first (volumes included) and the
 * proxy re-pointed, after which every per-feature volume is orphaned.
 *
 * The layout this emits — the volume lists, the `[dry-run] Would …` lines —
 * would normally be the CLI's, but it interleaves with the progress of the work
 * itself: the stale-slot scan shells out to `docker compose ps` *after* the
 * volumes are removed. Returning it all to be rendered at the end would reorder
 * the output, so it goes out through `raw` as it happens, as `up`'s
 * "Local services" line does.
 */
export async function runClean({
  all = false,
  dryRun = false,
}: {
  all?: boolean;
  dryRun?: boolean;
} = {}): Promise<CleanResult> {
  if (dryRun) {
    info("Dry run -- nothing will be removed\n");
  }

  const activeFeatures = Object.keys(await getAllSlots()).sort();
  // Emptied by an `--all` teardown: everything it stopped is orphaned after it.
  let live = new Set(activeFeatures);

  if (live.size) {
    raw(`  ${Colors.CYAN}Active features:${Colors.RESET} ${activeFeatures.join(", ")}\n`);
  } else {
    raw(`  ${Colors.DIM}No active features${Colors.RESET}\n`);
  }
  raw("\n");

  if (all && live.size) {
    info("--all: tearing down active features...");
    for (const feature of activeFeatures) {
      if (dryRun) {
        raw(`  ${Colors.DIM}[dry-run] Would stop: ${feature}${Colors.RESET}\n`);
        continue;
      }
      info(`Stopping ${feature}...`);
      if (!composeDown(feature, { removeVolumes: true })) {
        warn(`Containers for '${feature}' may still exist -- see the docker compose output above`);
      }
      releaseSlot(feature);
    }
    if (!dryRun) {
      await generateCaddyfile();
      if (isCaddyRunning()) {
        await reloadCaddy();
      }
    }
    raw("\n");
    live = new Set();
  }

  info("Scanning for per-feature Docker volumes...");
  const baseNames = volumeBaseNames();
  const sandboxVolumes = await listSandboxVolumes(baseNames);

  const removedVolumes: string[] = [];
  const { activeVolumes, orphanedVolumes } = classifyVolumes(sandboxVolumes, baseNames, live);

  if (!sandboxVolumes.length) {
    raw(`  ${Colors.DIM}No per-feature Docker volumes found${Colors.RESET}\n`);
  } else {
    if (activeVolumes.length) {
      raw(`\n  ${Colors.CYAN}Active feature volumes (kept):${Colors.RESET}\n`);
      for (const vol of activeVolumes) {
        raw(`    ${Colors.DIM}${vol}${Colors.RESET}\n`);
      }
    }

    if (orphanedVolumes.length) {
      raw(`\n  ${Colors.YELLOW}Orphaned volumes to remove:${Colors.RESET}\n`);
      for (const vol of orphanedVolumes) {
        if (dryRun) {
          raw(`    ${Colors.DIM}[dry-run] Would remove: ${vol}${Colors.RESET}\n`);
        } else if (await removeVolume(vol)) {
          raw(`    ${Colors.GREEN}Removed:${Colors.RESET} ${vol}\n`);
          removedVolumes.push(vol);
        } else {
          raw(`    ${Colors.RED}Failed:${Colors.RESET} ${vol} (may be in use)\n`);
        }
      }
      if (!dryRun) {
        success(`Removed ${removedVolumes.length}/${orphanedVolumes.length} orphaned volume(s)`);
      }
    } else {
      raw(`\n  ${Colors.DIM}No orphaned volumes found${Colors.RESET}\n`);
    }
  }

  // Re-read: an `--all` teardown has already released these.
  const remaining = Object.keys(await getAllSlots());
  const staleSlots: string[] = [];
  const releasedSlots: string[] = [];
  if (!all) {
    for (const feature of remaining) {
      const running = getContainerStatus(feature).filter((c) => c.status === "running");
      if (!running.length && workspaceForFeature(feature) === null) {
        staleSlots.push(feature);
      }
    }

    if (staleSlots.length) {
      raw(
        `\n  ${Colors.YELLOW}Stale slot entries ` +
          `(no running containers or compose file):${Colors.RESET}\n`,
      );
      for (const feature of staleSlots) {
        if (dryRun) {
          raw(`    ${Colors.DIM}[dry-run] Would release slot: ${feature}${Colors.RESET}\n`);
        } else {
          releaseSlot(feature);
          releasedSlots.push(feature);
          raw(`    ${Colors.GREEN}Released:${Colors.RESET} ${feature}\n`);
        }
      }
    }
  }

  return {
    activeFeatures,
    activeVolumes,
    orphanedVolumes,
    staleSlots,
    removedVolumes,
    releasedSlots,
  };
}

/**
 * A feature with no slot was never brought up (or has been torn down), so there
 * is nothing to act on. Shared because both callers must raise the *same* code
 * — the CLI matches on it to print its "start it with" hint.
 */
async function requireSlot(feature: string): Promise<number> {
  const slot = await getSlot(feature);
  if (slot === null) {
    throw new SandboxError(
      `Feature '${feature}' is not running (no slot allocated)`,
      "NOT_RUNNING",
    );
  }
  return slot;
}

export interface TeardownNotes {
  workspace: string | null;
  handoff: Note | null;
  decisions: Note[];
  /** Graduations whose scaffold has since been committed, closed out by this read. */
  graduated: Note[];
}

/**
 * The workspace notes a teardown wants to show, read before anything is removed.
 *
 * Ordering is the contract, not a detail: `workspaceForFeature` resolves through
 * compose labels on the feature's *still-running* containers, so this must be
 * called before `down`. Reconciling graduations here is what stops a decision
 * whose scaffold already landed from being offered again.
 *
 * Reading is all this does. Deciding whether to prompt about what comes back is
 * a TTY question, and stays with the caller.
 */
export async function teardownNotes(feature: string): Promise<TeardownNotes> {
  const workspace = workspaceForFeature(feature);
  if (workspace === null) {
    return { workspace: null, handoff: null, decisions: [], graduated: [] };
  }
  const graduated = reconcileGraduating(workspace);
  return {
    workspace,
    handoff: latestHandoff(workspace),
    decisions: openDecisions(workspace),
    graduated,
  };
}
