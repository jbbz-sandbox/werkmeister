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
 * merely warns about. `werkmeister infra up` is the one that does not even reach
 * `infra`: it means `werkmeister infra connect`, which is still a command module, so that
 * branch stays in the CLI until row 5g moves it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  agentOf,
  claimLastStop,
  clearPaused,
  clearWaiting,
  type LastStop,
  nudgePath,
  readPaused,
  readSessions,
  readWaiting,
  STALE_SESSION_MS,
  writeLastStop,
  writeNudge,
  writePaused,
  writeWaiting,
} from "./agent_state.js";
import { ensureSharedNetwork, isCaddyRunning, reloadCaddy, startCaddy } from "./caddy.js";
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
  composeUpServiceAsync,
  dependencyOrder,
  getContainerStatus,
  isOneShotService,
  liveProject,
  workspaceForFeature,
} from "./compose.js";
import { COMPOSE_FILE, migrateWorkspaceCompose } from "./compose_file.js";
import {
  getVolumeBaseNames,
  loadPorts,
  loadServices,
  needsCluster,
  sharedProxySkipReason,
} from "./config.js";
import {
  containerLogs,
  docker,
  listVolumeNames,
  projectContainers,
  removeVolume,
  runningExecCommands,
} from "./docker.js";
import { dotDir } from "./dot_dir.js";
import { SandboxError } from "./errors.js";
import {
  type HostLookup,
  ingressHostnames,
  loadFeatureRouters,
  warnUnresolvedHosts,
} from "./feature_routing.js";
import {
  generateCaddyfile,
  generateFeatureCompose,
  generateFeatureEnv,
  generateSupergraphConfig,
  isFeatureComposeStale,
  loadWorkspaceEnvVars,
  onDemandServices,
  type RegistryConfig,
  writeServiceSecretEnvs,
} from "./generate.js";
import { load as loadGlobalConfig } from "./global_config.js";
import { reconcileGraduating } from "./graduate.js";
import { writeAgentStateHooks } from "./harness/claude/hooks_gen.js";
import { hooksAvailable } from "./harness/layout.js";
import { ensurePortForwardsHealthy, waitForForwards } from "./k8s.js";
import { recordEvent } from "./metrics.js";
import { latestHandoff, type Note } from "./notes.js";
import { type RunResult, run } from "./proc.js";
import { workspaceServices } from "./registry_sync.js";
import { info, raw, success, warn } from "./reporter.js";
import { withStartRecord } from "./resources.js";
import {
  type Cost,
  headCanWaitOut,
  type Lease,
  queueOrder,
  type Rank,
  STARVE_MS,
} from "./scheduler.js";
import { schedulerOp, waitingQueue } from "./scheduler_client.js";
import {
  dequeue,
  enqueue,
  featureCost,
  loadBudget,
  readLeases,
  readQueue,
  requestAdmission,
  requeueFirst,
  reservedLeases,
  type Starting,
  serviceStarts,
  setupsCurrent,
  sweepVmLoadProbes,
  upServices,
  waiters,
  waitForSetupLoad,
} from "./scheduler_state.js";
import { getSecretsPath, loadSecrets, resolveSecrets } from "./secrets.js";
import {
  getAllSlots,
  getPortRange,
  getServicePort,
  getSlot,
  LABEL_FEATURE,
  LEGACY_LABEL_FEATURE,
  releaseSlot,
  requireLeasedSlot,
} from "./slots.js";
import { strategyFor } from "./strategies/index.js";
import { readAutonomous } from "./workspace_prompts.js";
import { commitRecord } from "./worktrees.js";

/**
 * The Claude layer's repair on every `up`. Each strategy repairs its own layer: jit
 * re-merges its hooks (a workspace created before a hook-template change otherwise
 * keeps the stale one), icm strips any a pre-strategy `up` installed. Both rewrite
 * `.claude/settings.json` and its record when the rule set grew since init (SW-172
 * added one), and both files are tracked on the record branch, so what changed is
 * committed as `workspace create` commits, or the branch is left dirty (SW-356).
 */
export function refreshWorkspaceSettings(workspace: string): void {
  strategyFor(workspace).refresh(workspace);
  if (
    commitRecord(workspace, "chore: refresh Claude settings", [
      ".claude/settings.json",
      ".werkmeister/claude-permissions.json",
    ])
  ) {
    info("Committed the refreshed .claude/settings.json on the record branch");
  }
}

/** Everything `werkmeister feature up` computed, separated from how the CLI renders it. */
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
  /** The compose file predated the current template or registry, so it was rewritten. */
  staleCompose: boolean;
  containersStarted: boolean;
  /** "skipped": Caddy was stopped and nothing in this workspace is routed (SW-42). */
  caddy: "reloaded" | "started" | "skipped";
  /** Queue position when the budget had no room: nothing was started (SW-181). */
  waiting?: number;
  /** With *waiting*: who holds the budget and what happens next (SW-675). */
  waitingNote?: string;
}

/**
 * Bring *feature* up: allocate its slot, start its containers, and point the
 * proxy at them. The k8s port-forwards are checked, and Caddy started, only when
 * a local service needs them (SW-42).
 *
 * *workspace* is passed in rather than resolved here: `resolveWorkspace` falls
 * back to the current directory, which is the caller's for an in-process caller
 * and so would silently point the dashboard at whatever it happened to be
 * running from. The CLI resolves it from argv and hands it over.
 *
 * Throws `NO_COMPOSE` when the workspace has no generated compose file,
 * `MISSING_SECRETS` when a secret this workspace's own services require is
 * absent, `SLOT_ALLOC` when no slot can be allocated, `FORWARDS_NEVER_READY`
 * when the forwards are restarted and their tunnels never reconnect, `HOST_LOAD`
 * when host load stays over budget before a setup service starts (SW-630), and
 * `COMPOSE_UP_FAILED` when `docker compose up` reports failure, and
 * `INSIDE_OWN_CONTAINER` before any of it when run inside *feature*'s own container.
 *
 * With no room in the budget it queues the feature instead and returns with
 * `waiting` set; *byPerson* (default: the workspace is not autonomous and no agent session runs it) may stop
 * working autonomous features to make room (SW-181); any start that doesn't fit
 * may stop features whose session is idle or waiting on a person (SW-546).
 */
export async function up(
  feature: string,
  workspace: string,
  { signal, byPerson }: { signal?: AbortSignal; byPerson?: boolean } = {},
): Promise<UpResult> {
  refuseInsideOwnContainer(feature, "up");
  refusePaused(feature, workspace);
  migrateWorkspaceCompose(workspace);
  if (!fs.existsSync(path.join(workspace, COMPOSE_FILE))) {
    throw new SandboxError(
      `No ${COMPOSE_FILE} found in workspace: ${workspace}\n` +
        "       Run 'werkmeister workspace init' first to generate it.",
      "NO_COMPOSE",
    );
  }

  // Config first because the proxy generation needs it, then fail on a missing
  // secret before any slot state is mutated or any container starts.
  info("Loading configuration...");
  const servicesConfig = workspaceServices(loadServices(), workspace);
  const config = { services: servicesConfig, ports: loadPorts() };
  const localServices = readServicesFromWorkspace(workspace);
  requireSecrets(servicesConfig, localServices, workspace);
  // Unlike compose, these files are fully generated, so rewriting them on every
  // `up` loses no hand-edits and picks up a rotated secret without init-workspace.
  writeServiceSecretEnvs(workspace, localServices, servicesConfig);

  refreshWorkspaceSettings(workspace);

  const { slot, regenerated, staleCompose } = await prepareSlot(
    feature,
    workspace,
    config,
    localServices,
  );
  const [portStart, portEnd] = getPortRange(slot);

  if (localServices.length) {
    // Before admission: a HOST_LOAD throw must not follow a preemption or a dequeue.
    await waitForSetupLoad(workspace, undefined);
    const waiting = await admitOrQueue(feature, workspace, byPerson ?? startsAsPerson(workspace));
    if (waiting !== null) {
      // Unqueued: a re-up of a running feature, which keeps running and is rerun, not granted (SW-909).
      const queued = readWaiting(workspace) !== null;
      warn(
        queued
          ? `Waiting for capacity, position ${waiting} — it starts when another feature stops`
          : `'${feature}' keeps running; no capacity yet to start the rest of its set`,
      );
      return {
        waitingNote: await capacityWait(feature, waiting, queued, featureCost(workspace)),
        feature,
        slot,
        portRange: [portStart, portEnd],
        localServices,
        urls: [],
        servicePorts: [],
        regenerated,
        staleCompose,
        containersStarted: false,
        caddy: "skipped",
        waiting,
      };
    }
  } else {
    // No admission to dequeue it, so a queued k8s-only feature would stay waiting and be re-upped on every grant (SW-245).
    await dequeue(feature);
    clearWaiting(workspace);
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

  const routers = loadFeatureRouters(servicesConfig);
  // Cluster fall-through routes through Caddy, so a cluster-backed workspace is routed too.
  const cluster = needsCluster(localServices, servicesConfig);
  const routed = cluster || localServices.some((s) => routers[s]);

  // Only a workspace that needs the cluster may inspect or restart the shared
  // forwarder: on 2026-10-18 a werkmeister-only `up` restarted it for everyone
  // while Kubernetes was being taken down (SW-42).
  if (cluster) {
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
    if ((await ensurePortForwardsHealthy()) === "restarted") {
      await waitForForwards();
    }
  } else {
    info("No local service needs the cluster -- skipping k8s port-forwards");
  }

  let containersStarted = false;
  if (localServices.length) {
    requireSharedNetwork();
    info("Starting containers...");
    if (
      !(await withStartRecord(workspace, "up", () => composeUpAsync(feature, signal))) &&
      (signal?.aborted || !(await startLeftCreated(feature, workspace)))
    ) {
      throw new SandboxError(
        // Not "above": a grant runs this in another process, and its nudge carries this text (SW-861).
        `Failed to start containers: \`werkmeister feature logs ${feature}\` shows why.${await failedSetupLines(feature)}`,
        "COMPOSE_UP_FAILED",
      );
    }
    containersStarted = true;
    // Up now: two admits return before the one that dequeues (Docker unreadable, a zero-cost start), and
    // a leftover entry keeps the hook saying "queued" over running containers (SW-863), as in restart().
    await dequeue(feature);
    clearWaiting(workspace);
    // Its stop is answered by this start; a later grant must not report it (SW-702). The grant claims it first.
    claimLastStop(workspace);
  } else {
    info("No local services to start -- routing entirely to k8s");
    const onDemand = onDemandServices(servicesConfig, localServices, workspace);
    if (onDemand.length)
      info(`start one with: werkmeister feature up --service <name> (${onDemand.join(", ")})`);
  }

  info("Configuring reverse proxy...");
  await generateCaddyfile(null, config);
  // Not gated on the Caddy skip below: the resolver is this machine's whichever Caddy serves (SW-341).
  await warnUnresolvedHosts(ingressHostnames(servicesConfig));

  let caddy: UpResult["caddy"];
  const caddySkip = sharedProxySkipReason();
  if (caddySkip) {
    info(`Caddy skipped (${caddySkip})`);
    caddy = "skipped";
  } else if (await isCaddyRunning()) {
    await reloadCaddy();
    caddy = "reloaded";
  } else if (routed) {
    info("Caddy not running -- starting it...");
    startCaddy();
    caddy = "started";
  } else {
    info("Caddy not running and nothing here is routed -- leaving it stopped");
    caddy = "skipped";
  }

  // Derivations, not rendering: they exist only inside the summary's
  // `console.log` today, which is why an in-process caller could never get at
  // the URL a feature is reachable on.
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

/**
 * Allocate *feature*'s slot, preferring the one in `.env`, and rewrite the
 * compose file when the slot moved or the file predates the template or registry.
 *
 * Throws `SLOT_ALLOC` when no slot can be allocated.
 */
async function prepareSlot(
  feature: string,
  workspace: string,
  config: RegistryConfig,
  localServices: string[],
): Promise<{ slot: number; regenerated: boolean; staleCompose: boolean }> {
  info("Allocating feature slot...");
  const preferredSlot = readSlotFromWorkspace(workspace);
  // Never moves a leased slot (SW-169); SLOT_ALLOC names whoever sits on it.
  const slot = await requireLeasedSlot(feature, workspace, preferredSlot);

  const [portStart, portEnd] = getPortRange(slot);
  info(`Slot ${slot} -> port range ${portStart}-${portEnd}`);

  const regenerated = preferredSlot !== null && slot !== preferredSlot;
  let staleCompose = false;
  if (regenerated) {
    warn(`Slot changed (${preferredSlot} → ${slot}) — regenerating compose...`);
    generateFeatureCompose(
      feature,
      slot,
      localServices,
      config,
      workspace,
      "werkmeister feature up",
    );
    generateFeatureEnv(feature, slot, localServices, config, workspace);
  } else if (isFeatureComposeStale(feature, slot, localServices, config, workspace)) {
    // Rewritten, not just warned about: the file is fully generated, and a
    // template change (SW-32's idle containers) must reach existing workspaces
    // without a re-init. Hand-edits belong in the registry or workspace.yml.
    staleCompose = true;
    warn(`${COMPOSE_FILE} predates the current template or registry — regenerating...`);
    generateFeatureCompose(
      feature,
      slot,
      localServices,
      config,
      workspace,
      "werkmeister feature up",
    );
  }
  return { slot, regenerated, staleCompose };
}

/**
 * Start one of *feature*'s services and wait for it, without the rest of `up`
 * (no Caddy, no port-forward check). The PR gate calls this for a repo with no
 * container running (SW-34). *service* may be outside the workspace's services:
 * compose.yml carries those behind the `on-demand` profile. *composeName* is
 * the gate's own render of a branch's settings (SW-118) when not compose.yml.
 *
 * *skipCurrentSetups* (the gate, SW-541) starts it `--no-deps` when its setup's install is
 * already current: compose would re-run it, and after an edit rebuild every package, while the
 * gate's own test command builds what it tests. `feature up --service` keeps the re-run, so a
 * service started alone after a pull gets a fresh dist/.
 *
 * Throws `INSIDE_OWN_CONTAINER`, `NO_COMPOSE`, `MISSING_SECRETS`, `SLOT_ALLOC`,
 * `NO_CAPACITY`, `NEVER_FITS`, `HOST_LOAD` or `COMPOSE_UP_FAILED`.
 */
export async function startService(
  feature: string,
  workspace: string,
  service: string,
  composeName: string = COMPOSE_FILE,
  {
    skipCurrentSetups = false,
    park = false,
    grant = true,
    waitMs,
  }: { skipCurrentSetups?: boolean; park?: boolean; grant?: boolean; waitMs?: number } = {},
): Promise<void> {
  refuseInsideOwnContainer(feature, "pr gate");
  migrateWorkspaceCompose(workspace);
  const composePath = path.join(workspace, COMPOSE_FILE);
  if (!fs.existsSync(composePath)) {
    throw new SandboxError(
      `No ${COMPOSE_FILE} found in workspace: ${workspace}\n` +
        "       Run 'werkmeister workspace init' first to generate it.",
      "NO_COMPOSE",
    );
  }
  const config = { services: workspaceServices(loadServices(), workspace), ports: loadPorts() };
  requireSecrets(config.services, [service], workspace);
  // compose refuses to start a service whose `.env.<svc>` is missing.
  writeServiceSecretEnvs(workspace, [service], config.services);
  await prepareSlot(feature, workspace, config, readServicesFromWorkspace(workspace));
  const noDeps =
    skipCurrentSetups && (await setupsCurrent(path.join(workspace, composeName), service));
  // Before admission, as in `up`: a HOST_LOAD throw must not follow a preemption.
  await waitForSetupLoad(workspace, noDeps ? [service] : serviceStarts(workspace, service));
  await admitServiceStart(feature, workspace, service, {
    noDeps,
    park,
    grant,
    ...(waitMs !== undefined && { waitMs }),
  });
  let started: boolean;
  try {
    requireSharedNetwork();
    started = await withStartRecord(workspace, "gate", () =>
      composeUpServiceAsync(feature, service, path.join(workspace, composeName), noDeps),
    );
  } finally {
    // Its admit reservation ends with the start, as `up`'s dequeue ends its (SW-907 review).
    await dequeue(feature);
    // After the start, not at admission: admission prices only running containers, so a grant before
    // it would hand a waiter the room this start is about to take (SW-737).
    if (grant) await grantIfQueued();
  }
  if (!started) {
    // A timed-out or cancelled up leaves the container Created, never started (SW-86).
    const state = (await getContainerStatus(feature)).find((c) => c.service === service)?.status;
    throw new SandboxError(
      `Failed to start ${service}${state ? ` (left ${state})` : ""}: \`werkmeister feature logs ${feature} ${service}\` shows why${await failedSetupLines(feature)}`,
      "COMPOSE_UP_FAILED",
    );
  }
}

/**
 * The last lines of each setup container of *feature* that exited non-zero, for a failed start's
 * message: its dependents never start, and the cause was otherwise only in `docker logs` (SW-1012).
 * Empty when none failed.
 */
async function failedSetupLines(feature: string): Promise<string> {
  const failed = (await getContainerStatus(feature)).filter(
    (c) => isOneShotService(c.service, c.role) && c.status === "exited" && c.exitCode !== 0,
  );
  const lines: string[] = [];
  for (const c of failed) {
    lines.push(`${c.name} exited ${c.exitCode}; its last lines:`);
    await containerLogs(
      await liveProject(feature),
      c.service,
      { follow: false, tail: 20, color: false },
      (line) => lines.push(`  ${line}`),
    );
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
}

const SERVICE_POLL_MS = 15_000;
const SERVICE_WAIT_MS = 10 * 60_000;
/** One deadline for all of a `pr gate` / `pr open` run's service starts (SW-869): giving up drops the queue place, so wait longer in place rather than ask for a rerun. */
export const GATE_CAPACITY_WAIT_MS = 30 * 60_000;

/**
 * Admit starting *service* (and what compose starts with it) against the budget,
 * waiting in the queue up to 10 min (SW-540): since SW-342 these starts are the
 * only ones, so skipping admission here let a wave of 8 onto 12 cores. A fixed
 * poll, not a backoff: the queue is FIFO, so a sleeping head would idle freed room.
 *
 * Throws `NO_CAPACITY` when the wait is spent, `NEVER_FITS` at once when the start costs more than the whole budget.
 */
export async function admitServiceStart(
  feature: string,
  workspace: string,
  service: string,
  {
    sleep = delay,
    waitMs = SERVICE_WAIT_MS,
    noDeps = false,
    park = false,
    grant = true,
  }: {
    sleep?: (ms: number) => Promise<unknown>;
    waitMs?: number;
    noDeps?: boolean;
    /** On timeout keep the queue place for a grant to start it (SW-701); never after a release. */
    park?: boolean;
    /** False inside a grant pass, which would otherwise wait on itself. */
    grant?: boolean;
  } = {},
): Promise<void> {
  const ownRunning = (await getContainerStatus(feature)).filter((c) => c.status === "running");
  const up = new Set(ownRunning.map((c) => c.service));
  const services = (noDeps ? [service] : serviceStarts(workspace, service)).filter(
    (s) => !up.has(s),
  );
  if (!services.length) return;
  // A queued whole start (a plain `up`, or a preemption) asks for more than this one: this replaces it (SW-1017).
  const queued = readWaiting(workspace);
  if (queued && !queued.services && (await waitingQueue()).includes(feature)) {
    await dequeue(feature);
    clearWaiting(workspace);
    info(`'${feature}' left the queue for its whole start; starting ${service} instead`);
  }
  let starting: Starting = { services };
  let released: string[] = [];
  let admitted = false;
  let parked = false;
  try {
    for (let waited = 0; ; waited += SERVICE_POLL_MS) {
      // Never byPerson: an agent's gate in a person's workspace must not stop another run's containers.
      let position = await admitOrQueue(feature, workspace, false, starting);
      // Not in a person's workspace: their running app must not go down because they asked for one more service.
      // Nor in the grant pass (SW-873): with no wait it would stop its own set and drop it, never parked.
      if (
        position !== null &&
        grant &&
        ownRunning.length &&
        !released.length &&
        readAutonomous(workspace)
      ) {
        // Release instead of hold (SW-675): two gates each holding core while waiting for one more
        // service deadlock a full budget. Stopped, not removed: one request then brings back the set.
        await stop(feature, { grant: false });
        released = ownRunning.map((c) => c.name);
        starting = { services: [...up, ...services], gate: true };
        info(`Stopped ${[...up].join(", ")} while waiting, so '${feature}' holds no capacity`);
        position = await admitOrQueue(feature, workspace, false, starting);
      }
      if (position === null) {
        admitted = true;
        // Through compose, not by name: a db + app pair needs depends_on order and health waits (SW-686).
        if (
          released.length &&
          !(await composeUpServiceAsync(feature, [...up], path.join(workspace, COMPOSE_FILE), true))
        ) {
          const running = new Set(
            (await getContainerStatus(feature))
              .filter((c) => c.status === "running")
              .map((c) => c.name),
          );
          throw new SandboxError(
            `Could not start ${[...up].join(", ")} again after waiting for capacity; still stopped: ` +
              `${released.filter((n) => !running.has(n)).join(", ") || "none"}. ` +
              "`werkmeister feature up` starts the feature again.",
            "COMPOSE_UP_FAILED",
          );
        }
        return;
      }
      if (waited >= waitMs) {
        // A released set can't park: the grant would bring back *service*, not what it stopped.
        const waiting = park && !released.length ? readWaiting(workspace) : null;
        if (waiting) {
          writeWaiting(workspace, { ...waiting, parked: { service } });
          parked = true;
        }
        throw new SandboxError(
          `No capacity to start ${services.join(", ")} for '${feature}' after ${Math.round(waitMs / 60_000)} min ` +
            `(queue position ${position})${parked ? "; it stays queued" : ""}.` +
            (released.length
              ? ` ${[...up].join(", ")} stayed stopped; \`werkmeister feature up\` starts the feature again.`
              : "") +
            `\n${await capacityWait(feature, position, parked, featureCost(workspace, starting.services))}`,
          "NO_CAPACITY",
        );
      }
      if (!waited) {
        warn(
          // SW-734: say how a wait the person doesn't want ends.
          `Waiting for capacity to start ${services.join(", ")}: position ${position}, up to ${Math.round(waitMs / 60_000)} min. ` +
            "Stopping the command ends the wait; `pr gate` and `pr open` start no service the PR file's `skip_tests` names.",
        );
      }
      await sleep(SERVICE_POLL_MS);
    }
  } finally {
    if (!admitted && !parked) {
      await dequeue(feature);
      clearWaiting(workspace);
    }
    // Room it released, or held as the queue head, is free now and no stop will grant it (SW-737).
    if (!admitted && grant) await grantIfQueued();
  }
}

/**
 * After compose gave up (its 20 min ran out), start the containers of a plain `up` it left Created, never
 * started, as `docker start` did by hand (SW-973). Only once every other container has settled: a setup
 * exited 0, the rest running and not still `starting`. A running install or a failed one is what its
 * dependents wait on by design, so compose's failure stands (false). Throws naming any that won't start.
 */
async function startLeftCreated(feature: string, workspace: string): Promise<boolean> {
  const all = await getContainerStatus(feature);
  // An on-demand service a failed `--service` start left Created was never priced for this `up`.
  const plain = new Set(upServices(workspace));
  const created = all.filter((c) => c.status === "created" && plain.has(c.service));
  const settled = all
    .filter((c) => c.status !== "created")
    .every((c) =>
      c.status === "exited"
        ? c.exitCode === 0
        : c.status === "running" &&
          !isOneShotService(c.service, c.role) &&
          c.health !== "starting" &&
          c.health !== "unhealthy",
    );
  if (!created.length || !settled) return false;
  const names = created.map((c) => c.name);
  const stuck: string[] = [];
  for (const name of names) {
    try {
      await docker().getContainer(name).start();
    } catch {
      stuck.push(name);
    }
  }
  if (stuck.length)
    throw new SandboxError(
      `docker compose gave up with ${stuck.join(", ")} left Created, and starting it failed. ` +
        `\`docker start ${stuck.join(" ")}\` starts it by hand; \`werkmeister feature logs ${feature}\` shows why.`,
      "COMPOSE_UP_FAILED",
    );
  warn(`docker compose gave up with ${names.join(", ")} left Created; started it directly`);
  return true;
}

/** A grant pass when anyone waits: room can free without a release, and only a grant starts a whole-feature waiter (SW-737). */
async function grantIfQueued(): Promise<void> {
  if (readQueue().length) await grantWaitersQuietly();
}

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;
const cpus = (n: number) => `${Number(n.toFixed(1))} CPUs`;

export const RANK_WORD: Record<Rank, string> = {
  idle: "idle",
  "human-check": "waiting on a person",
  working: "working",
  person: "a person's workspace",
};

/** A running lease for a person to read: `name (3 CPUs, 0.8 GiB, idle, run in flight)`. */
export function describeLease(l: Lease): string {
  return `${l.feature} (${cpus(l.cost.cpus)}, ${gib(l.cost.memory)}, ${RANK_WORD[l.rank]}${l.busy ? ", run in flight" : ""})`;
}

/**
 * Who holds the budget, the head *feature* waits behind, and what happens next: the same lines for a
 * queued `up` and a timed-out service start (SW-675). *stays*: still queued, so the grant starts it.
 */
export async function capacityWait(
  feature: string,
  position: number,
  stays: boolean,
  need: Cost,
): Promise<string> {
  const running = runningLeases() ?? [];
  const lines = [
    `running: ${running.map(describeLease).join(", ") || "nothing werkmeister started"}`,
  ];
  // What is asked against what is free, so a too-big request reads apart from a busy host (SW-763).
  const budget = await loadBudget();
  if (Number.isFinite(budget.memory)) {
    // Admission also counts admitted starts not yet running (SW-907 review).
    const used = [...running, ...reservedLeases(running, feature)].reduce(
      (a, l) => ({ cpus: a.cpus + l.cost.cpus, memory: a.memory + l.cost.memory }),
      { cpus: 0, memory: 0 },
    );
    // CPUs only when budget.cpus caps them: by default load gates them, not the budget (SW-992).
    const capped = Number.isFinite(budget.cpus);
    lines.push(
      `this start needs ${capped ? `${cpus(need.cpus)}, ` : ""}${gib(need.memory)}; free ` +
        `${capped ? `${cpus(Math.max(0, budget.cpus - used.cpus))}, ` : ""}${gib(Math.max(0, budget.memory - used.memory))} ` +
        `of the budget's ${capped ? `${cpus(budget.cpus)}, ` : ""}${gib(budget.memory)}`,
    );
  }
  const head = position > 1 ? queueOrder(waiters(readQueue(), running))[0] : undefined;
  if (head && head.feature !== feature) {
    const ws = readLeases()[head.feature]?.workspace;
    const need = ws ? featureCost(ws, readWaiting(ws)?.services) : null;
    lines.push(
      `behind ${head.feature}${need ? ` (needs ${cpus(need.cpus)}, ${gib(need.memory)})` : ""}` +
        // A parked head never holds (SW-701), nor one only a person's stop could fit (SW-903).
        (head.waitedMs >= STARVE_MS && !head.parked && headCanWaitOut(budget, running, head)
          ? `, which has waited ${Math.round(head.waitedMs / 60_000)} min and gets the next free room`
          : ""),
    );
  }
  lines.push(
    stays
      ? "It starts by itself when room frees, and the session is told to continue. Exit 75: queued, not a failure."
      : "Exit 75: no capacity yet, not a failure of the change. Rerun the same command; nothing to ask a person.",
  );
  // Never *feature* itself: a re-up of a running one waits here too, and its own stop frees nothing for it (SW-909).
  const others = running.filter((l) => l.feature !== feature);
  if (others.length && others.every((l) => l.rank === "person"))
    lines.push(
      `Only a person can free room: werkmeister feature stop ${others.map((l) => l.feature).join(" or ")}.`,
    );
  return lines.join("\n");
}

/** Throws `COMPOSE_UP_FAILED` when the external network every feature compose joins can't be made. */
function requireSharedNetwork(): void {
  if (!ensureSharedNetwork()) {
    throw new SandboxError("Could not create the werkmeister-shared network", "COMPOSE_UP_FAILED");
  }
}

// ponytail: two hand-rolled parsers over the same file, because `loadDotenv`
// walks up from a start directory and these must read exactly this workspace's
// .env. Collapse them into one read if a third key is ever needed.

/** Read WERKMEISTER_SLOT from <workspace>/.env. */
function readSlotFromWorkspace(workspace: string): number | null {
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile()) {
    return null;
  }
  for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("WERKMEISTER_SLOT=")) {
      const value = line.slice("WERKMEISTER_SLOT=".length).trim();
      const n = Number(value);
      if (value !== "" && Number.isInteger(n)) {
        return n;
      }
    }
  }
  return null;
}

/**
 * Reads the services a workspace runs: the `SERVICES` list in its `.env`, which
 * `werkmeister workspace init` writes. Runs in-process and only reads that file.
 *
 * @param workspace - Absolute path of the workspace folder.
 * @returns The service names, in file order. Empty when the `.env` or its
 *   `SERVICES` line is missing.
 *
 * @example
 * ```ts
 * import { readServicesFromWorkspace, resolveWorkspaceDir } from "werkmeister-core/sdk";
 *
 * const dir = await resolveWorkspaceDir("my-workspace");
 * console.log(readServicesFromWorkspace(dir)); // e.g. ["api", "web"]
 * ```
 */
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
        `       Run \`werkmeister machine setup\` to write a template to ${secretsPath}, ` +
        "then fill in the missing values (or pin them under `env_vars:` in " +
        ".werkmeister/workspace.yml).",
      "MISSING_SECRETS",
    );
  }
}

/**
 * True when this process runs inside *feature*'s own container: every
 * workspace container exports `WERKMEISTER_FEATURE` (`SANDBOX_FEATURE` before
 * SW-106), and Docker writes `/.dockerenv`. Reads the caller's env about *itself*.
 * Drop `SANDBOX_FEATURE` with the transition in env.njk.
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
      `'werkmeister ${verb}' is running inside ${feature}'s own container, which it would ` +
        "recreate or stop and so kill itself.\n" +
        `       Run it from the host: cd to the workspace and run 'werkmeister ${verb}'.`,
      "INSIDE_OWN_CONTAINER",
    );
  }
}

/** A feature that was running, and the slot it keeps while stopped. */
export interface StopResult {
  feature: string;
  /** null: it held no slot, and the stop only took its queued start out of the queue (SW-1017). */
  slot: number | null;
}

/** What `werkmeister internal session-end` knows when a SessionEnd hook runs it (#231). */
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
}

// `/clear` and `/resume` end a session but the same process carries on in the next one.
const _CONTINUING_REASONS = new Set(["clear", "resume"]);

/** An open harness session in a workspace, from the hooks' liveness record (SW-182). */
export interface LiveSession {
  sessionId: string;
  status: "busy" | "idle";
  /** Epoch ms of the last status change. */
  statusUpdatedAt: number;
  /** Parked on a question or plan prompt for a person; a permission prompt is mid-turn (SW-910, SW-919). */
  asking: boolean;
}

/** The open sessions in *workspaceRoot*, as Werkmeister's hooks recorded them. */
export function liveSessions(workspaceRoot: string, now = Date.now()): LiveSession[] {
  return (
    Object.entries(readSessions(workspaceRoot, now))
      // `last` is the newest hook; older records have only `at`, when the status began.
      .map(([sessionId, s]) => ({
        sessionId,
        status: s.status,
        statusUpdatedAt: Date.parse(s.last ?? s.at),
        asking: s.ask !== undefined && s.ask.kind !== "permission",
      }))
      // readSessions keeps idle records and asks of any age; a day-silent one isn't open.
      .filter((s) => now - s.statusUpdatedAt < STALE_SESSION_MS)
  );
}

/** Ids of the sessions in *workspaceRoot* other than *sessionId*. */
export function otherLiveSessions(workspaceRoot: string, sessionId: string | null): string[] {
  return liveSessions(workspaceRoot)
    .map((s) => s.sessionId)
    .filter((id) => id !== sessionId);
}

/** A feature with running containers, from their compose labels. */
export interface RunningFeature {
  feature: string;
  workspace: string;
  /** Each running container's `State.StartedAt`, epoch ms. */
  startedAt: number[];
  /** Σ `HostConfig.MemoryReservation`, bytes. */
  memory: number;
  /** Σ `HostConfig.NanoCpus`, cores. */
  cpus: number;
  /** `docker exec`s running in its containers now (`.ExecIDs`: Docker drops an exec when it exits). */
  execs: number;
  /** Each running container's compose service, where labelled. */
  services: string[];
}

export interface IdleInput {
  minutes: number;
  now: number;
  running: RunningFeature[];
  sessions: (
    workspace: string,
  ) => (Pick<LiveSession, "status" | "statusUpdatedAt"> & { asking?: boolean })[];
  /** Someone waits for capacity: then a session parked on a person past the cutoff is reclaimable (SW-675). */
  queued?: boolean;
  /** Epoch ms the gate last ran `docker exec` in *workspace*, or null. */
  lastExec: (workspace: string) => number | null;
}

/** Why a running feature is not idle, or null when it is. */
function busyReason(f: RunningFeature, input: IdleInput, cutoff: number): string | null {
  // A test run or probe in its container is work in flight, whatever the session record says (SW-856).
  if (f.execs) return "docker exec running";
  // An open session that has sat idle past the cutoff does not count (SW-39 D3), nor, while others
  // queue, one that has waited on a person that long: its status stays busy through the ask (SW-675).
  const recent = (s: { statusUpdatedAt: number }) => (s.statusUpdatedAt ?? Infinity) > cutoff;
  const active = input
    .sessions(f.workspace)
    .some((s) => (s.asking && input.queued ? recent(s) : s.status !== "idle" || recent(s)));
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

const LABEL_WORKDIR = "com.docker.compose.project.working_dir";

/** Running feature containers grouped by feature; null when docker cannot be read. */
export function runningFeatures(
  runCmd: (cmd: string[]) => RunResult = (cmd) => run(cmd, { capture: true, timeout: 20 }),
): RunningFeature[] | null {
  try {
    // One `ps` per label set: docker ANDs repeated label filters.
    const list = new Set<string>();
    for (const label of [LABEL_FEATURE, LEGACY_LABEL_FEATURE]) {
      const ids = runCmd(["docker", "ps", "-q", "--filter", `label=${label}`]);
      if (ids.status !== 0) return null;
      for (const id of ids.stdout.split("\n").filter(Boolean)) list.add(id);
    }
    if (!list.size) return [];
    const feature = `or (index .Config.Labels "${LABEL_FEATURE}") (index .Config.Labels "${LEGACY_LABEL_FEATURE}")`;
    // `.ExecIDs` is nil with no exec in flight, and `len` of it fails the whole inspect (SW-972).
    const fmt = `{{${feature}}}\t{{index .Config.Labels "${LABEL_WORKDIR}"}}\t{{.State.StartedAt}}\t{{.HostConfig.MemoryReservation}}\t{{.HostConfig.NanoCpus}}\t{{if .ExecIDs}}{{len .ExecIDs}}{{else}}0{{end}}\t{{index .Config.Labels "com.docker.compose.service"}}`;
    const inspect = runCmd(["docker", "inspect", "--format", fmt, ...list]);
    if (inspect.status !== 0) return null;
    const byFeature = new Map<string, RunningFeature>();
    for (const line of inspect.stdout.split("\n").filter(Boolean)) {
      const [feature, workspace, started, memory, nanoCpus, execs, service] = line.split("\t");
      if (!feature || !workspace) continue;
      const f = byFeature.get(feature) ?? {
        feature,
        workspace,
        startedAt: [],
        memory: 0,
        cpus: 0,
        execs: 0,
        services: [],
      };
      f.startedAt.push(Date.parse(started));
      f.memory += Number(memory) || 0;
      f.cpus += (Number(nanoCpus) || 0) / 1e9;
      f.execs += Number(execs) || 0;
      // `index` prints "<no value>" for a missing label.
      if (service && service !== "<no value>") f.services.push(service);
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
  run?: (cmd: string[]) => RunResult;
  stop?: (feature: string, opts: { why: string }) => Promise<unknown>;
  /** Override for whether anyone waits for capacity; default: the queue file. */
  queued?: boolean;
}

/**
 * `werkmeister internal reap <minutes>` and the `watchPrs` reaper (SW-39): stop each
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
  const now = opts.now ?? Date.now();
  const input: IdleInput = {
    minutes,
    now,
    running,
    sessions: (ws) => liveSessions(ws, now),
    lastExec: (ws) => mtimeMs(lastExecMarker(ws)),
    queued: opts.queued ?? readQueue().length > 0,
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
    const asking = input.sessions(f.workspace).some((s) => s.asking);
    try {
      await (opts.stop ?? stop)(f.feature, { why: `idle ≥ ${minutes} min` });
      lines.push(
        asking
          ? `${f.feature}: stopped (waiting on a person ≥ ${minutes} min, others queued)`
          : `${f.feature}: stopped (idle ≥ ${minutes} min)`,
      );
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
  const { feature, workspaceRoot, sessionId, reason, entrypoint } = input;
  if (!feature || feature === "infra") return null;
  if (reason && _CONTINUING_REASONS.has(reason)) return null;
  // A headless turn ends its "session" every turn; the next turn needs the containers.
  if (entrypoint?.startsWith("sdk")) return null;
  if (otherLiveSessions(workspaceRoot, sessionId).length) return null;
  return feature;
}

/** A feature that was running, and the slot its restarted containers reuse. */
export interface RestartResult {
  feature: string;
  slot: number;
}

const GRANTED_NUDGE =
  "Capacity freed: this workspace's containers are up. Continue where you left off.";

/**
 * The granted session's nudge. Preemption stops on-demand containers too, and the grant's `up` starts
 * only the default set, so name each one left stopped and how to start it (SW-840).
 */
async function grantedNudge(feature: string, last: LastStop | null): Promise<string> {
  const stopped = (await getContainerStatus(feature)).filter(
    (c) => c.status !== "running" && !isOneShotService(c.service, c.role),
  );
  // Say why it was down at all (SW-702): nothing else tells the session who stopped it.
  const why = last
    ? `Werkmeister had stopped it (${last.why})` +
      (last.killed.length
        ? `, killing ${last.killed.map((c) => `\`${c}\``).join(", ")}: rerun them`
        : "") +
      ". "
    : "";
  if (!stopped.length) return why + GRANTED_NUDGE;
  return (
    `${why}Capacity freed: this workspace started, but these containers are still stopped: ${stopped.map((c) => c.name).join(", ")}. ` +
    `Start them with ${stopped.map((c) => `\`werkmeister feature up --service ${c.service}\``).join(", ")}, ` +
    "then continue where you left off."
  );
}

/**
 * Every running feature as the scheduler sees it, read from Docker now (never a
 * pid: `up` exits once containers start). Longest-inactive first, so ties in
 * preemption go to the feature nothing has touched longest. Null when Docker
 * can't be read.
 *
 * A non-autonomous workspace is a person's and is never preempted, unless its
 * session is parked on a question or plan prompt (SW-546); a permission prompt is mid-turn (SW-910).
 * Nor is the shared infra.
 */
export function runningLeases(runCmd?: (cmd: string[]) => RunResult): Lease[] | null {
  const found = runningFeatures(runCmd);
  if (!found) return null;
  // At least two of the gate's 60 s heartbeats: idle_stop_minutes 0 (reaper off) made every gate preemptable (SW-745).
  const gateCutoff = Date.now() - Math.max(idleStopMinutes(), 2) * 60_000;
  // Its session's record predates the start, so a grant's next head took it for idle and stopped it (SW-989).
  const holdCutoff = Date.now() - STARVE_MS;
  return found
    .map((f) => {
      const sessions = readSessions(f.workspace);
      const state = agentOf(sessions);
      // A permission prompt is mid-turn, often on a `docker exec` into this feature: it ranks as its turn (SW-910).
      const prompted = Object.values(sessions).some((s) => s.ask?.kind === "permission");
      // The oldest start: a crash-looping container restarts on its own and must not hold its feature forever.
      const justStarted = f.startedAt.length > 0 && Math.min(...f.startedAt) > holdCutoff;
      const rank: Rank =
        f.feature === "infra"
          ? "person"
          : state?.agent === "needs-you" && !prompted && !justStarted
            ? "human-check"
            : !readAutonomous(f.workspace)
              ? "person"
              : state?.agent === "working" || prompted || justStarted
                ? "working"
                : "idle";
      // A running `docker exec` (a session's test run, not only the gate's) is never stopped (SW-856).
      const busy =
        f.execs > 0 ||
        readPaused(f.workspace) !== null ||
        (mtimeMs(lastExecMarker(f.workspace)) ?? 0) > gateCutoff;
      // Admission prices compose; a container started with no or lower limits read as free (SW-907).
      const declared = f.services.length
        ? featureCost(f.workspace, f.services)
        : { memory: 0, cpus: 0 };
      const lease: Lease = {
        feature: f.feature,
        cost: {
          memory: Math.max(f.memory, declared.memory),
          cpus: Math.max(f.cpus, declared.cpus),
        },
        rank,
        busy,
        ...(f.services.length && { services: f.services }),
      };
      return { lease, at: state ? Date.parse(state.at) : 0 };
    })
    .sort((a, b) => a.at - b.at)
    .map((x) => x.lease);
}

/**
 * Whether a plain `up` here may stop working features: a person's workspace, not an agent in it. Claude
 * Code sets CLAUDECODE=1 in its Bash tool, so an agent's start there admits as an agent (SW-738).
 */
export function startsAsPerson(workspace: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !readAutonomous(workspace) && !env["CLAUDECODE"];
}

/** Null when *feature* may start now (after any preemption); else its queue position. */
export function admitOrQueue(
  feature: string,
  workspace: string,
  byPerson: boolean,
  starting?: Starting,
): Promise<number | null> {
  return schedulerOp(
    "admit",
    { feature, workspace, byPerson, starting },
    () => admitOrQueueHere(feature, workspace, byPerson, starting),
    // Preemption stops the victims' containers first.
    15 * 60_000,
  );
}

async function admitOrQueueHere(
  feature: string,
  workspace: string,
  byPerson: boolean,
  starting?: Starting,
): Promise<number | null> {
  const running = runningLeases();
  // Docker unreadable: let compose up report it rather than queue on a guess.
  if (running === null) return null;
  const budget = await loadBudget();
  const decision = await requestAdmission(feature, workspace, byPerson, running, budget, starting);
  if (decision.kind === "never-fits") {
    const { cost } = decision;
    const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;
    const over =
      cost.cpus > budget.cpus
        ? `cost ${cost.cpus.toFixed(1)} CPUs > budget ${budget.cpus}; raise the engine's CPUs or budget.cpus`
        : `cost ${gib(cost.memory)} memory > budget ${gib(budget.memory)}; raise the engine's memory or budget.memory`;
    throw new SandboxError(
      `'${feature}' can never fit the budget${starting ? ` to start ${starting.services.join(", ")}` : ""}: ` +
        `${over} in ~/.werkmeister/config.yaml, or start fewer services.`,
      "NEVER_FITS",
    );
  }
  if (decision.kind === "wait") return decision.position;
  if (decision.kind === "preempt") {
    for (const victim of decision.victims) {
      const victimWs = readLeases()[victim]?.workspace || workspaceForFeature(victim);
      try {
        // stop, not pause: a paused container keeps its memory.
        await stop(victim, { grant: false, why: `preempted to make room for '${feature}'` });
      } catch (e) {
        // A failed stop can still have killed it (SW-738): queue it to come back, and wait rather than
        // start over budget; this start had the head's turn, so it keeps it. A victim that still runs
        // stays out of the queue, or the hook holds its agent over live containers (SW-831).
        const stillRuns = (await getContainerStatus(victim)).some((c) => c.status === "running");
        if (victimWs && !stillRuns) await enqueue(victim, victimWs);
        warn(
          `Could not stop '${victim}' to make room (${(e as Error).message}); waiting instead` +
            (stillRuns ? `, and '${victim}' keeps running` : ""),
        );
        // A re-up of a running feature waits unqueued, as requestAdmission has it (SW-909).
        if (!starting && running.some((l) => l.feature === feature)) return 1;
        return requeueFirst(feature, workspace, starting);
      }
      if (victimWs) await enqueue(victim, victimWs);
      const why = running.find((l) => l.feature === victim)?.rank;
      recordEvent({
        event: "queue.preempt",
        workspace: path.basename(victimWs || victim),
        feature: victim,
        rank: why ?? "idle",
        for: feature,
      });
      info(
        `Stopped '${victim}' to make room: its session is ` +
          `${why === "human-check" ? "waiting on a person" : why === "working" ? "working" : "idle"} ` +
          "(preemption; budget.preempt: false turns it off)",
      );
    }
  }
  return null;
}

/**
 * Start each queued feature that fits now, first come first served.
 * Each started one's live session gets a "continue". Returns those started.
 */
export function grantWaiters(): Promise<string[]> {
  return schedulerOp("grant", {}, grantHere, 15 * 60_000);
}

// One grant at a time in this process: two at once would both start the queue head.
let granting: Promise<unknown> = Promise.resolve();
function grantHere(): Promise<string[]> {
  const next = granting.then(grantWaitersNow, grantWaitersNow);
  granting = next.catch(() => {});
  return next;
}

/** The daemon's side of a client's release (SW-185 D3): start waiters without holding the caller. */
export function grantInBackground(): number {
  const queued = readQueue().length;
  if (queued) void grantHere().catch((e: Error) => warn(`Waiting queue: ${e.message}`));
  return queued;
}

async function grantWaitersNow(): Promise<string[]> {
  const started: string[] = [];
  for (const feature of readQueue()) {
    // A lease pruned by a process that can't see the folder must not cost the waiter its start (SW-848).
    const workspace = readLeases()[feature]?.workspace || workspaceForFeature(feature);
    if (!workspace) {
      // No folder to nudge in: say it here, at least (SW-873).
      warn(`'${feature}' left the waiting queue: its workspace can't be found`);
      await dequeue(feature);
      continue;
    }
    // Before up(), which drops the record on any start, so only this grant's nudge reports it (SW-702).
    const last = claimLastStop(workspace);
    try {
      const waiting = readWaiting(workspace);
      if (waiting?.parked) {
        if (await startParked(feature, workspace, waiting.parked.service)) {
          started.push(feature);
          if (liveSessions(workspace).length)
            writeNudge(workspace, await grantedNudge(feature, last));
        }
        continue;
      }
      // A service start's own poll admits it; `up` would start the wrong set and dequeue it.
      if (waiting?.services) continue;
      let r: UpResult;
      try {
        r = await up(feature, workspace, { byPerson: false });
      } catch (e) {
        // One waiter's failed re-up (HOST_LOAD, NO_COMPOSE, ...) must not end the pass for the rest (SW-737).
        const message = `Could not start '${feature}' from the waiting queue: ${(e as Error).message}`;
        warn(message);
        // Admission already dropped it (never fits, or a start that failed after admit): only its session can act (SW-682, SW-848).
        if (!readQueue().includes(feature)) {
          clearWaiting(workspace);
          // A never-fits rerun would fail the same way; its message already says what to change.
          const neverFits = e instanceof SandboxError && e.code === "NEVER_FITS";
          writeNudge(
            workspace,
            neverFits
              ? message
              : `${message}\nIt left the queue: run \`werkmeister feature up\` to queue it again.`,
          );
        }
        continue;
      }
      // Backfill (SW-675): a later waiter may fit; admission itself holds the room for a starved head.
      if (r.waiting !== undefined) continue;
      started.push(feature);
      if (liveSessions(workspace).length) writeNudge(workspace, await grantedNudge(feature, last));
    } finally {
      // Still waiting: the grant that starts it reports the stop.
      if (last && !started.includes(feature) && readQueue().includes(feature))
        writeLastStop(workspace, last);
    }
  }
  return started;
}

/**
 * A parked `--service` start (SW-701), as `feature up --service` runs it, without its wait: no room
 * parks it again in place. False when it did not start.
 */
async function startParked(feature: string, workspace: string, service: string): Promise<boolean> {
  try {
    await startService(feature, workspace, service, COMPOSE_FILE, {
      park: true,
      waitMs: 0,
      grant: false, // this is the grant pass: another would wait on it
    });
  } catch (e) {
    // No room keeps it parked; any other way out of the queue its session must hear (SW-873).
    if (
      !(e instanceof SandboxError && e.code === "NO_CAPACITY") ||
      !readQueue().includes(feature)
    ) {
      const message = `Could not start '${feature}' ${service} from the waiting queue: ${(e as Error).message}`;
      warn(message);
      // Its session was told it continues once started; it must hear that it won't (SW-701 review).
      writeNudge(workspace, message);
    }
    return false;
  }
  // startService skips Caddy, as `feature up --service` does before its own reload (SW-338).
  await reloadProxy().catch((e: Error) =>
    warn(`Proxy not reloaded for '${feature}': ${e.message}`),
  );
  return true;
}

/**
 * After a release: a client hands the queue to the daemon and returns; the
 * daemon, or a client without one, starts waiters here. Never fails the stop
 * or down that freed the room.
 */
async function grantWaitersQuietly(): Promise<void> {
  try {
    const handedOff = await schedulerOp<number | null>("grant-later", {}, async () => null);
    if (handedOff !== null) {
      if (handedOff) info(`The daemon will start the next waiting feature (${handedOff} waiting)`);
      return;
    }
    for (const f of await grantHere()) success(`Started '${f}' from the waiting queue`);
  } catch (e) {
    warn(`Could not start the next waiting feature: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Take *feature* out of the capacity queue and clear its waiting.json; false when it was not queued. */
async function dropQueuedStart(feature: string): Promise<boolean> {
  if (!readQueue().includes(feature)) return false;
  await dequeue(feature);
  const workspace = readLeases()[feature]?.workspace || workspaceForFeature(feature);
  if (workspace) clearWaiting(workspace);
  return true;
}

/**
 * What a session hears when werkmeister stopped its containers under these commands (SW-856):
 * they died with them (exit 137), so the session reruns them rather than reading a test failure.
 */
export function killedNudge(why: string, killed: string[]): string {
  return (
    `Werkmeister stopped this workspace's containers (${why}) while these ran in them: ` +
    `${killed.map((c) => `\`${c}\``).join(", ")}. They were killed (exit 137), not failed: start the ` +
    "containers with `werkmeister feature up` (`--service <name>` for an on-demand one), then rerun them."
  );
}

/**
 * Stop *feature*'s containers, leaving them and its slot in place so
 * `restart`/`up` can resume it.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot and is not queued (queued only: it leaves the
 * queue and returns `slot: null`), and `COMPOSE_STOP_FAILED` when a container fails to stop.
 */
export async function stop(
  feature: string,
  { grant = true, why }: { grant?: boolean; why?: string } = {},
): Promise<StopResult> {
  refuseInsideOwnContainer(feature, "stop");
  // A person's or agent's own stop also ends its queued start (SW-1017). Not preemption's or the reaper's
  // (*why*), which requeue it or never queued it, nor a gate's release (no grant), which keeps its place.
  const dropped = grant && !why && (await dropQueuedStart(feature));
  // A start queued before it ever ran holds no slot: leaving the queue is the whole stop.
  if (dropped && (await getSlot(feature)) === null) {
    info(`'${feature}' left the waiting queue; it had not started`);
    await grantWaitersQuietly();
    return { feature, slot: null };
  }
  const slot = await requireSlot(feature);
  // *why* marks a stop nobody in the workspace asked for: name what it kills to the session (SW-856).
  const workspace = why ? workspaceForFeature(feature) : null;
  if (why && workspace) {
    const names = (await getContainerStatus(feature))
      .filter((c) => c.status === "running")
      .map((c) => c.name);
    const killed = await runningExecCommands(names);
    // Best effort: a folder gone, or unseen from a container (SW-860), must not block the stop.
    try {
      writeLastStop(workspace, { at: new Date().toISOString(), why, killed });
      if (killed.length) writeNudge(workspace, killedNudge(why, killed));
    } catch (e) {
      warn(`Could not tell '${feature}' why it stopped: ${(e as Error).message}`);
    }
  }

  info(`Stopping containers for '${feature}' (slot ${slot})...`);
  if (!(await composeStop(feature))) {
    throw new SandboxError(`Failed to stop containers for '${feature}'`, "COMPOSE_STOP_FAILED");
  }

  if (grant) await grantWaitersQuietly();
  return { feature, slot };
}

/**
 * Restart *feature*'s containers in place.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, `PAUSED` while it is
 * paused, and `COMPOSE_RESTART_FAILED` when a container fails to restart.
 */
export async function restart(feature: string): Promise<RestartResult> {
  refuseInsideOwnContainer(feature, "restart");
  const slot = await requireSlot(feature);

  const workspace = workspaceForFeature(feature);
  refusePaused(feature, workspace);
  info(`Restarting containers for '${feature}' (slot ${slot})...`);
  const restarted = workspace
    ? await withStartRecord(workspace, "restart", () => composeRestart(feature))
    : await composeRestart(feature);
  if (!restarted) {
    throw new SandboxError(
      `Failed to restart containers for '${feature}'`,
      "COMPOSE_RESTART_FAILED",
    );
  }
  // Running again, so no longer waiting: a queue entry left here held its session over live containers (SW-713).
  await dequeue(feature);
  if (workspace) clearWaiting(workspace);

  return { feature, slot };
}

/** Containers running while the session is held would undo the pause: Resume is the way back. */
function refusePaused(feature: string, workspace: string | null): void {
  if (workspace && readPaused(workspace)) {
    throw new SandboxError(`'${feature}' is paused; Resume it first`, "PAUSED");
  }
}

function workspaceOrThrow(feature: string): string {
  const workspace = workspaceForFeature(feature);
  if (!workspace) {
    throw new SandboxError(`No workspace folder for '${feature}'`, "NO_WORKSPACE");
  }
  return workspace;
}

const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;
const daemonMessage = (e: unknown) =>
  (e as { json?: { message?: string } }).json?.message ?? (e as Error).message;

export interface PauseResult {
  feature: string;
  slot: number;
  containers: string[];
}

/**
 * Freeze *feature*'s running containers and hold its Claude session (SW-70).
 *
 * The record is written before the first freeze, so the hook gate holds the
 * session before it can see a frozen container and try to fix it. A partial
 * failure keeps the record, so Resume undoes what did freeze.
 *
 * Throws `NOT_RUNNING`, `NO_WORKSPACE`, `ALREADY_PAUSED` or `COMPOSE_PAUSE_FAILED`.
 */
export async function pause(feature: string): Promise<PauseResult> {
  refuseInsideOwnContainer(feature, "pause");
  const slot = await requireSlot(feature);
  const workspace = workspaceOrThrow(feature);
  if (readPaused(workspace)) {
    throw new SandboxError(`'${feature}' is already paused`, "ALREADY_PAUSED");
  }
  const live = await projectContainers(await liveProject(feature), undefined, { all: false });
  if (live === null)
    throw new SandboxError("docker not found / not running", "COMPOSE_PAUSE_FAILED");
  const containers = dependencyOrder(live.filter((c) => c.state === "running")).map((c) => c.name);

  // A workspace from before SW-46 has no agent-state hook, and so no gate.
  if (hooksAvailable(workspace)) writeAgentStateHooks(workspace);
  writePaused(workspace, {
    at: new Date().toISOString(),
    containers,
    was_working: agentOf(readSessions(workspace))?.agent === "working",
  });

  info(`Pausing ${containers.length} container(s) for '${feature}' (slot ${slot})...`);
  const failed: string[] = [];
  for (const name of [...containers].reverse()) {
    try {
      await docker().getContainer(name).pause();
    } catch (e) {
      // 409: already paused, which is the goal.
      if (statusOf(e) !== 409) failed.push(`${name}: ${daemonMessage(e)}`);
    }
  }
  if (failed.length) {
    throw new SandboxError(`docker pause failed: ${failed.join("; ")}`, "COMPOSE_PAUSE_FAILED");
  }
  success(`Paused '${feature}': its Claude session is held until Resume`);
  return { feature, slot, containers };
}

/**
 * What resuming a paused workspace brought back: the containers it unpaused or
 * restarted, and whether its agent was mid-turn when paused.
 * {@link resumeAndNudge} returns it, plus how the session was told to continue.
 * The SDK has no bare `resume`: it would leave an agent that was mid-turn
 * waiting, so resume through `resumeAndNudge` or `runWorkspaceAction("resume")`.
 *
 * @example
 * ```ts
 * import { resumeAndNudge, type ResumeResult } from "werkmeister-core/sdk";
 *
 * const r: ResumeResult = await resumeAndNudge(
 *   "my-workspace",
 *   "/Users/me/features/my-workspace",
 *   "my-workspace",
 * );
 * const missing = r.containers.filter((c) => c.did === "missing").map((c) => c.name);
 * if (missing.length) console.warn(`Gone since the pause: ${missing.join(", ")}`);
 * ```
 */
export interface ResumeResult {
  /** The feature that was resumed. */
  feature: string;
  /** Absolute path of the feature's workspace folder. */
  workspace: string;
  /** Each container Pause froze, in pause order; one already running is left out. */
  containers: {
    /** Docker container name. */
    name: string;
    /** `started` when it had been stopped meanwhile; `missing` when it no longer exists. */
    did: "unpaused" | "started" | "missing";
  }[];
  /** True when the agent was mid-turn at pause time, so its session should be told to continue. */
  wasWorking: boolean;
}

/**
 * Bring back exactly the containers Pause froze, then release the session. One
 * stopped meanwhile (■ Stop, the idle reaper) is started; telling the session to
 * continue is the caller's job (`resumeAndNudge` in sandbox.ts).
 *
 * Throws `NO_WORKSPACE`, `NOT_PAUSED` or `COMPOSE_RESUME_FAILED`.
 */
export async function resume(feature: string): Promise<ResumeResult> {
  refuseInsideOwnContainer(feature, "resume");
  const workspace = workspaceOrThrow(feature);
  const rec = readPaused(workspace);
  if (!rec) throw new SandboxError(`'${feature}' is not paused`, "NOT_PAUSED");

  info(`Resuming ${rec.containers.length} container(s) for '${feature}'...`);
  const containers: ResumeResult["containers"] = [];
  for (const name of rec.containers) {
    const c = docker().getContainer(name);
    try {
      const { State } = await c.inspect();
      if (State.Paused) {
        await c.unpause();
        containers.push({ name, did: "unpaused" });
      } else if (!State.Running) {
        await c.start();
        containers.push({ name, did: "started" });
      }
    } catch (e) {
      if (statusOf(e) !== 404) {
        throw new SandboxError(
          `docker resume ${name} failed: ${daemonMessage(e)}`,
          "COMPOSE_RESUME_FAILED",
        );
      }
      warn(`${name} is gone; nothing to resume`);
      containers.push({ name, did: "missing" });
    }
  }
  // Last, so the session never wakes into a frozen container.
  clearPaused(workspace);
  success(`Resumed '${feature}'`);
  return { feature, workspace, containers, wasWorking: rec.was_working };
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
 * Does not touch the reverse proxy: `werkmeister feature down --all-features` tears down N
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
    const { leaveFeatureIntercepts, releaseIdleTelepresence } = await import("./telepresence.js");
    const left = leaveFeatureIntercepts(feature);
    if (left.length) {
      info(`Left k8s intercept(s): ${left.join(", ")}`);
    }
    await releaseIdleTelepresence(left);
  } catch (exc) {
    // teardown must never block on telepresence
    warn(`Could not clean up k8s intercepts: ${exc instanceof Error ? exc.message : String(exc)}`);
  }

  // Before the teardown: workspaceForFeature reads the containers' labels first.
  const workspace = workspaceForFeature(feature);
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

  // Before the slot goes: the lease names the workspace whose waiting.json to clear (SW-1017).
  await dropQueuedStart(feature);
  info("Releasing feature slot...");
  await releaseSlot(feature);
  // Tearing down ends a pause, and a wait: there is nothing left to resume or start.
  if (workspace) {
    clearPaused(workspace);
    clearWaiting(workspace);
    fs.rmSync(nudgePath(workspace), { force: true });
  }

  await grantWaitersQuietly();
  return { feature, slot };
}

/**
 * What {@link removeService} did: the service that now routes to Kubernetes,
 * what the feature still runs locally, and what happened to its containers and
 * the proxy.
 *
 * @example
 * ```ts
 * import { removeService, type RemoveResult } from "werkmeister-core/sdk";
 *
 * const r: RemoveResult = await removeService("my-feature", "api");
 * console.log(r.containersStopped ? "nothing local left" : `still local: ${r.remaining.join(", ")}`);
 * ```
 */
export interface RemoveResult {
  /** The feature the service was dropped from. */
  feature: string;
  /** The service that now falls back to k8s. */
  removed: string;
  /** The feature's surviving local services, sorted. */
  remaining: string[];
  /** True when nothing local was left, so the containers were stopped rather than restarted. */
  containersStopped: boolean;
  /** False when Caddy was not running, so only the Caddyfile was rewritten. */
  proxyReloaded: boolean;
}

// `NOT_LOCAL` replaces an early return, so the CLI catches it to print the same
// warning and local-services line it always did; that is why the message
// carries no list.
/**
 * Stops running one service locally in a running feature, so its traffic goes
 * to the Kubernetes cluster instead. Regenerates the feature's compose, env and
 * supergraph files, restarts its containers (or stops them when nothing local
 * is left), and re-points the Caddy proxy. Runs in-process and talks to Docker
 * directly.
 *
 * @param feature - The feature name (a running workspace's stack).
 * @param service - A service the feature runs locally.
 * @returns What changed: see {@link RemoveResult}.
 * @throws {@link SandboxError} with code `NOT_RUNNING` when the feature is not
 *   up, or `NOT_LOCAL` when it does not run *service* locally.
 *
 * @example
 * ```ts
 * import { removeService, SandboxError } from "werkmeister-core/sdk";
 *
 * try {
 *   const { remaining } = await removeService("my-feature", "api");
 *   console.log(`api now routes to k8s; local: ${remaining.join(", ") || "none"}`);
 * } catch (e) {
 *   if (e instanceof SandboxError && e.code === "NOT_LOCAL") console.log("api was not local");
 *   else throw e;
 * }
 * ```
 */
export async function removeService(feature: string, service: string): Promise<RemoveResult> {
  // shortcut: renders the registry's view, not the branch fragment's (SW-337), because no
  // workspace path reaches here; the next `up` sees the compose as stale and re-renders it.
  // Pass the workspace in, as `up` does, if a removed service must keep branch settings.
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
  if (await isCaddyRunning()) {
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

/**
 * What {@link reloadProxy} wrote into the regenerated Caddyfile, and whether
 * Caddy accepted it.
 *
 * @example
 * ```ts
 * import { reloadProxy, type ProxyReloadResult } from "werkmeister-core/sdk";
 *
 * const r: ProxyReloadResult = await reloadProxy();
 * for (const f of r.features)
 *   console.log(`${f.feature} (slot ${f.slot}): ${f.services.join(", ") || "all k8s"}`);
 * if (!r.ok) console.error("Caddy rejected the new config");
 * ```
 */
export interface ProxyReloadResult {
  /** The features written into the Caddyfile, sorted by name. */
  features: {
    /** Feature name. */
    feature: string;
    /** The slot number its ports are offset by. */
    slot: number;
    /** Services it runs locally; empty when everything routes to k8s. */
    services: string[];
  }[];
  /** True when Caddy was down and `start` was set, so it was started rather than reloaded. */
  started: boolean;
  /** False when Caddy rejected the config, or failed to start. */
  ok: boolean;
}

// Same shape and reason as `telepresence.ts`'s `Runner`: a trailing parameter
// defaulted to the real thing. It is deliberately the *whole* boundary rather
// than a caddy runner alone: `getAllSlots` reads Docker container labels, so
// faking the proxy half and not the slot half would still need a real daemon.
/**
 * The side effects {@link reloadProxy} performs: writing the Caddyfile, reading
 * which features are up, and checking, reloading or starting Caddy. Leave it
 * out to use the real ones; pass your own to run `reloadProxy` without Docker
 * or a live Caddy, for example in a test.
 *
 * @example
 * ```ts
 * import { type ProxyOps, reloadProxy } from "werkmeister-core/sdk";
 *
 * const ops: ProxyOps = {
 *   generate: async () => undefined,
 *   slots: async () => ({ "my-feature": { slot: 1, services: ["api"] } }),
 *   running: async () => true,
 *   reload: async () => true,
 *   start: () => true,
 *   hosts: () => [],
 * };
 * console.log(await reloadProxy({}, ops));
 * ```
 */
export interface ProxyOps {
  /** Writes the Caddyfile; its result is ignored. */
  generate: () => Promise<unknown>;
  /** Every feature holding a slot, keyed by feature name. */
  slots: () => Promise<
    Record<
      string,
      {
        /** The slot number its ports are offset by. */
        slot: number;
        /** Services it runs locally. */
        services: string[];
      }
    >
  >;
  /** Whether the Caddy container is up. */
  running: () => Promise<boolean>;
  /** Hands Caddy the new Caddyfile; false when Caddy rejected it. */
  reload: () => Promise<boolean>;
  /** Starts Caddy when it is down; false when it failed to start. */
  start: () => boolean;
  /** Every host the Caddyfile just written routes. */
  hosts: () => string[];
  /** Resolves a host name, to warn about hosts that don't resolve. Omitted: the system resolver. */
  lookup?: HostLookup;
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
  hosts: () => ingressHostnames(),
};

// Separate from `down` so a multi-feature teardown pays for one reload rather
// than one per feature. `start` selects the whole `werkmeister infra
// proxy-reload` spelling (its progress wording and feature list), not just the
// start-if-down fallback; teardown's callers print neither, and defaulting it to
// false stops a teardown starting a proxy nobody asked for.
/**
 * Regenerates the Caddy proxy config from the features that are up and hands
 * it to Caddy, so every workspace URL points at the right containers. Call it
 * after tearing down features. Runs in-process and talks to Docker directly.
 *
 * @param options - `start`: when Caddy is not running, start it (and list the
 *   features written) instead of skipping the reload. Defaults to false.
 * @param ops - The side effects to use. Leave it out for the real Caddyfile,
 *   Docker and Caddy; see {@link ProxyOps}.
 * @returns The features written and whether Caddy took the config; see
 *   {@link ProxyReloadResult}. A rejected config gives `ok: false` rather than
 *   throwing.
 *
 * @example
 * ```ts
 * import { reloadProxy } from "werkmeister-core/sdk";
 *
 * const { ok, started } = await reloadProxy({ start: true });
 * if (!ok) console.error("Caddy did not accept the new config");
 * else if (started) console.log("Caddy was down, so it was started");
 * ```
 */
export async function reloadProxy(
  { start = false }: { start?: boolean } = {},
  ops: ProxyOps = REAL_PROXY_OPS,
): Promise<ProxyReloadResult> {
  // SW-555: the Caddyfile routes every workspace, so a branch build under internal branch-cli must not write it.
  if (process.env.WERKMEISTER_BRANCH_CLI === "1") {
    warn(
      "Routing not refreshed under branch-cli: run `werkmeister infra proxy-reload` (installed CLI)",
    );
    return { features: [], started: false, ok: true };
  }
  info(start ? "Regenerating Caddyfile..." : "Updating reverse proxy configuration...");
  await ops.generate();
  await warnUnresolvedHosts(ops.hosts(), ops.lookup);

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
  if (await ops.running()) {
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
 * workspace volume — volume cleanup is skipped rather than guessing at names.
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
 * Every Docker volume name that looks like a workspace per-feature volume.
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

/**
 * What a cleanup sweep found, before it removed anything: the features that
 * are up, their per-feature Docker volumes, volumes left behind by features
 * that are gone, and slot entries with nothing behind them.
 * {@link planClean} returns it.
 *
 * @example
 * ```ts
 * import { type CleanPlan, planClean } from "werkmeister-core/sdk";
 *
 * const plan: CleanPlan = await planClean();
 * console.log(
 *   `${plan.orphanedVolumes.length} orphaned volume(s), ${plan.staleSlots.length} stale slot(s)`,
 * );
 * ```
 */
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

/**
 * What a cleanup sweep found (the {@link CleanPlan} fields) and what it then
 * actually removed. {@link runClean} returns it.
 *
 * @example
 * ```ts
 * import { type CleanResult, runClean } from "werkmeister-core/sdk";
 *
 * const r: CleanResult = await runClean();
 * const failed = r.orphanedVolumes.filter((v) => !r.removedVolumes.includes(v));
 * if (failed.length) console.warn(`Could not remove (in use?): ${failed.join(", ")}`);
 * ```
 */
export interface CleanResult extends CleanPlan {
  /** Orphaned volumes actually deleted; empty on a dry run, and short of `orphanedVolumes` when a removal failed. */
  removedVolumes: string[];
  /** Stale slots actually released; empty on a dry run. */
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
    // SW-110: `fix-shop-node-modules` is live feature `fix-shop` under `node-modules`, or `fix` under
    // `shop-node-modules`. Any reading that leaves a live feature keeps it: a wrong one deletes node_modules.
    const isLive = baseNames.some(
      (b) => vol.endsWith(`-${b}`) && live.has(vol.slice(0, -b.length - 1)),
    );
    (isLive ? activeVolumes : orphanedVolumes).push(vol);
  }
  return { activeVolumes, orphanedVolumes };
}

// A dry run *is* the plan: the two share one traversal because the ordering of
// the progress they report is the CLI's output contract.
/**
 * Reports what {@link runClean} would remove, without removing anything: it is
 * `runClean` with `dryRun` set. Runs in-process and reads Docker directly.
 *
 * @param opts - `all`: plan as if every running feature were torn down first,
 *   so all per-feature volumes count as orphaned. Defaults to false.
 * @returns What the sweep found; see {@link CleanPlan}. Its progress is also
 *   printed as it goes.
 *
 * @example
 * ```ts
 * import { planClean, runClean } from "werkmeister-core/sdk";
 *
 * const plan = await planClean();
 * if (plan.orphanedVolumes.length || plan.staleSlots.length) await runClean();
 * ```
 */
export async function planClean(opts: { all?: boolean } = {}): Promise<CleanPlan> {
  return runClean({ ...opts, dryRun: true });
}

// The layout this emits (the volume lists, the `[dry-run] Would …` lines)
// would normally be the CLI's, but it interleaves with the work itself: the
// stale-slot scan runs `docker compose ps` *after* the volumes are removed.
// Returning it all to render at the end would reorder the output, so it goes
// out through `raw` as it happens.
/**
 * Cleans up after features that are gone: removes their leftover per-feature
 * Docker volumes and releases slot entries that have neither a running
 * container nor a workspace behind them. Volumes of features that are still
 * up are kept. Runs in-process and talks to Docker directly, printing its
 * progress as it goes.
 *
 * @param options - `all`: first tear down every running feature (volumes
 *   included) and re-point the proxy, so every per-feature volume is removed.
 *   `dryRun`: report only, remove nothing (same as {@link planClean}). Both
 *   default to false.
 * @returns What it found and what it removed; see {@link CleanResult}. A
 *   volume that could not be removed (usually still in use) is left out of
 *   `removedVolumes` rather than throwing.
 *
 * @example
 * ```ts
 * import { runClean } from "werkmeister-core/sdk";
 *
 * const { removedVolumes, releasedSlots } = await runClean();
 * console.log(`Removed ${removedVolumes.length} volume(s), released ${releasedSlots.length} slot(s)`);
 * ```
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
      await releaseSlot(feature);
    }
    if (!dryRun) {
      await generateCaddyfile();
      if (await isCaddyRunning()) {
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
      const running = (await getContainerStatus(feature)).filter((c) => c.status === "running");
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
          await releaseSlot(feature);
          releasedSlots.push(feature);
          raw(`    ${Colors.GREEN}Released:${Colors.RESET} ${feature}\n`);
        }
      }
    }
  }

  // `docker run --rm` removes only a container that ran: the probe's 4 s cap can kill it in between (SW-969).
  const probes = sweepVmLoadProbes(dryRun);
  if (probes.length)
    raw(
      `\n  ${dryRun ? `${Colors.DIM}[dry-run] Would remove` : `${Colors.GREEN}Removed`} ` +
        `${probes.length} leftover load-probe container(s)${Colors.RESET}\n`,
    );

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
  const { decisions } = strategyFor(workspace);
  const graduated = reconcileGraduating(workspace, null, decisions);
  return {
    workspace,
    handoff: latestHandoff(workspace),
    decisions: decisions.open(workspace),
    graduated,
  };
}
