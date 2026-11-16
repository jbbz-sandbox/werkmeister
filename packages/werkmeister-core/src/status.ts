/**
 * The computing half of `werkmeister feature status`: the collectors and the machine-readable
 * snapshot, with no rendering.
 *
 * The boundary is §4's: what derives state lives here, what formats it stays in
 * the CLI command. Every `print*` function and the argv branching are still
 * there, and nothing in this module writes to stdout.
 *
 * `StatusSnapshot` is snake_case on purpose. It *is* `werkmeister feature status --json`'s
 * shape, key for key, so the renderer is a bare `JSON.stringify` and there is one
 * type rather than two that can drift apart.
 */

import { type CacheSnapshot, cacheSnapshots } from "./build_caches.js";
import {
  type ContainerStatus,
  getContainerStatus,
  isOneShotService,
  liveProject,
} from "./compose.js";
import { INFRA_PROJECT } from "./compose_infra.js";
import { loadServices } from "./config.js";
import { projectContainers } from "./docker.js";
import { type ForwardStatus, getPerServiceStatus } from "./k8s.js";
import {
  type CrashLoop,
  getWorkspaceResources,
  type HostSummary,
  type ProjectHealth,
  projectHealth,
  type StartedBy,
  type WorkspaceResources,
} from "./resources.js";
// The only core module that reaches into `sandbox.ts`, for a one-line predicate
// whose other caller already lives there. Splitting it out would touch a second
// module for no gain.

import { waitingQueue } from "./scheduler_client.js";
import { getAllSlots, getPortRange, type SlotEntry, slotCount } from "./slots.js";
import {
  type InterceptState,
  interceptBlocker,
  isRemoteService,
  listIntercepts,
  runAsyncRunner,
} from "./telepresence.js";
import { type WebServerStatus, status as webStatus } from "./web_servers.js";

export interface InfraContainer {
  service: string;
  display: string;
}

/** Return status of the live shared-infra containers, as `compose ps` without `-a` lists them. */
export async function getInfraStatus(): Promise<InfraContainer[]> {
  const containers = (await projectContainers(INFRA_PROJECT, undefined, { all: false })) ?? [];
  return containers.map(({ service, state, health }) => {
    let display: string;
    if (health === "healthy") {
      display = "healthy";
    } else if (health === "starting") {
      display = "starting";
    } else if (state === "running") {
      display = "running";
    } else {
      display = state || "down";
    }
    return { service: service || "unknown", display };
  });
}

/** The port range a slot owns, as the `start-end` string status renders. */
export function featurePortRange(slot: number | string): string {
  if (typeof slot === "number") {
    const [portStart, portEnd] = getPortRange(slot);
    return `${portStart}-${portEnd}`;
  }
  return "?";
}

/**
 * A one-shot setup container that ran to completion. Its dependents wait on
 * `service_completed_successfully`, so exiting 0 is the success case — counting
 * it as a stopped service would make a fully healthy feature read as `partial`
 * now that stopped containers are listed at all. A non-zero exit is a real
 * failure and stays in the tally.
 */
export function finishedSetup(c: ContainerStatus): boolean {
  return isOneShotService(c.service, c.role) && c.status === "exited" && c.exitCode === 0;
}

/** The containers a feature's up/down verdict is counted over. */
export function tallied(containers: ContainerStatus[]): ContainerStatus[] {
  return containers.filter((c) => !finishedSetup(c));
}

/** Sort feature entries by slot (missing/non-numeric slots sort last, as 99). */
export function sortedSlots(allSlots: Record<string, SlotEntry>): [string, SlotEntry][] {
  return Object.entries(allSlots).sort((a, b) => {
    const sa = typeof a[1].slot === "number" ? a[1].slot : 99;
    const sb = typeof b[1].slot === "number" ? b[1].slot : 99;
    return sa - sb;
  });
}

// ---------------------------------------------------------------------------
// Intercepts
// ---------------------------------------------------------------------------

export interface InterceptRow {
  feature: string;
  service: string;
  /** The k8s Deployment this service maps to, or null if it has none. */
  deployment: string | null;
  interceptable: boolean;
  /** Why not, when `interceptable` is false. */
  blocker: string | null;
  intercepted: boolean;
  /**
   * The feature owning the intercept — from its `x-feature` header filter.
   * Null when unreadable: telepresence allows one intercept per deployment, so
   * a consumer must not assume an intercept of unknown ownership is its own.
   */
  intercepted_by: string | null;
}

/**
 * Join every active feature's services against the registry and the set of
 * intercepted deployments.
 *
 * Pure — the caller supplies all three inputs. `intercepted` is gated on
 * `interceptable` so a deployment-name collision can never mark a service with
 * no k8s coordinates as intercepted.
 */
export function buildInterceptRows(
  allSlots: Record<string, SlotEntry>,
  registry: Record<string, any>,
  state: InterceptState,
): InterceptRow[] {
  const rows: InterceptRow[] = [];
  for (const [feature, info] of sortedSlots(allSlots)) {
    for (const service of info.services ?? []) {
      const svcDef = registry[service];
      const blocker = interceptBlocker(svcDef);
      const deployment = blocker === null ? String(svcDef["k8s_deployment"]) : null;
      const owner = deployment !== null ? state.intercepts.get(deployment) : undefined;
      rows.push({
        feature,
        service,
        deployment,
        interceptable: blocker === null,
        blocker,
        intercepted: owner !== undefined,
        intercepted_by: owner ?? null,
      });
    }
  }
  return rows;
}

/**
 * Runner for the telepresence reads below, capped well under the 120s default.
 * Async since SW-184: the daemon serves every client from one event loop, so a
 * wedged telepresence must stall only the request waiting on it.
 *
 * ponytail: one number for every read. Split it if they ever need to differ.
 */
const STATUS_READ = (cmd: string[]) => runAsyncRunner(cmd, undefined, 15);

/**
 * Telepresence intercepts across every running workspace, as
 * {@link interceptsSnapshot} returns it. It is the same data
 * `werkmeister feature status --intercepts --json` prints.
 *
 * @example
 * ```ts
 * import { interceptsSnapshot, type InterceptsSnapshot } from "werkmeister-core/sdk";
 *
 * const snap: InterceptsSnapshot = await interceptsSnapshot();
 * if (!snap.installed) console.log("telepresence is not installed");
 * const blocked = snap.intercepts.filter((r) => !r.interceptable);
 * for (const r of blocked) console.log(`${r.feature}/${r.service}: ${r.blocker}`);
 * ```
 */
export interface InterceptsSnapshot {
  /** False when telepresence couldn't be asked (not installed, disconnected, or errored). */
  available: boolean;
  /** Telepresence is on PATH, connected or not: a disconnected install can still intercept. */
  installed: boolean;
  /** The namespace the telepresence daemon is connected to; null when not connected. */
  connected_namespace: string | null;
  /**
   * One row per running workspace and local service; empty when telepresence is
   * not installed. Each row has `feature`, `service`, `deployment` (the k8s
   * Deployment, or null), `interceptable`, `blocker` (why not, or null),
   * `intercepted`, and `intercepted_by` (the feature holding the intercept, or
   * null when that can't be read; don't assume an intercept of unknown owner is
   * yours).
   */
  intercepts: InterceptRow[];
  /**
   * Registry services with k8s coordinates, sorted. Filled even when
   * telepresence is missing, so a UI can hide the intercept control on
   * local-only services.
   */
  remote_services: string[];
}

/**
 * Reports telepresence intercepts across every running workspace: one row per
 * workspace and service, saying whether it can be intercepted and who holds the
 * intercept. It is the same data `werkmeister feature status --intercepts --json`
 * prints. Runs in-process; it shells out to `telepresence` (each read capped at
 * 15 seconds) and reads `~/.werkmeister/services.yaml`.
 *
 * @returns An object with:
 *   - `available` and `installed`: whether telepresence is usable, and whether
 *     it is on PATH at all (a disconnected install can still intercept).
 *   - `connected_namespace`: the cluster namespace it is connected to, or null.
 *   - `intercepts`: one row per workspace and service, with `feature`,
 *     `service`, `deployment`, `interceptable`, `blocker` (why not),
 *     `intercepted` and `intercepted_by` (the owning workspace, or null when
 *     unknown). Empty when telepresence is not installed.
 *   - `remote_services`: the services with k8s coordinates, sorted, even when
 *     telepresence is missing.
 *
 * @example
 * ```ts
 * import { interceptsSnapshot } from "werkmeister-core/sdk";
 *
 * const snap = await interceptsSnapshot();
 * for (const row of snap.intercepts.filter((r) => r.intercepted)) {
 *   console.log(`${row.service} → ${row.intercepted_by ?? "unknown owner"}`);
 * }
 * ```
 */
export async function interceptsSnapshot(): Promise<InterceptsSnapshot> {
  const state = await listIntercepts(STATUS_READ);
  const registry = loadServices();
  // No telepresence, nothing interceptable: rows would claim `interceptable: true` (SW-2).
  const intercepts = state.installed
    ? buildInterceptRows(await getAllSlots(), registry, state)
    : [];
  return {
    available: state.available,
    installed: state.installed,
    connected_namespace: state.namespace,
    intercepts,
    remote_services: Object.keys(registry)
      .filter((name) => isRemoteService(registry[name]))
      .sort(),
  };
}

// ---------------------------------------------------------------------------
// The full snapshot
// ---------------------------------------------------------------------------

export interface FeatureSnapshot {
  name: string;
  slot: number | string;
  services: string[];
  port_range: string;
  /**
   * The *tallied* containers — finished setup containers are already filtered
   * out, so this matches `containers_total` rather than what Docker lists. The
   * verbose renderer wants the unfiltered list and fetches its own.
   */
  containers: ContainerStatus[];
  containers_running: number;
  containers_total: number;
  intercepts: InterceptRow[];
  /** Null when the stats sweep failed or the feature runs nothing. */
  cpu_percent: number | null;
  mem_mib: number | null;
  started_at: string | null;
  started_by: StartedBy | null;
  crash_loops: CrashLoop[];
}

/**
 * The whole machine in one read, as {@link statusSnapshot} returns it. It is
 * the same data `werkmeister feature status --json` prints.
 *
 * @example
 * ```ts
 * import { statusSnapshot, type StatusSnapshot } from "werkmeister-core/sdk";
 *
 * const snap: StatusSnapshot = await statusSnapshot();
 * for (const f of snap.features) {
 *   console.log(`${f.name}: ${f.containers_running}/${f.containers_total} up, ports ${f.port_range}`);
 * }
 * console.log(`${snap.summary.available_slots} slots free, ${snap.waiting.length} waiting`);
 * ```
 */
export interface StatusSnapshot {
  /**
   * Machine load: `load` (1, 5 and 15 minute averages), `cores`, and
   * `featureCpuPercent` (all workspace containers' CPU summed). Null when the
   * docker stats sweep failed.
   */
  host: HostSummary | null;
  /** The running shared-infrastructure containers (the proxy and the like), each with `service` and a `display` state; stopped ones are left out. */
  infrastructure: InfraContainer[];
  /** The workspaces dashboard web server: `running`, `pid`, `port`, `url` and `healthy`. */
  mcp_web_server: WebServerStatus;
  /** One entry per k8s port-forward the registry declares: `name`, `listen_port`, `remote_port`, `health_path` and `status` (`alive` when its health check passes). */
  k8s_forwards: ForwardStatus[];
  /**
   * Every workspace holding a slot, in slot order. Each has `name`, `slot`,
   * `services`, `port_range` (`start-end`), `containers` (one-shot setup
   * containers that finished cleanly are left out), `containers_running`,
   * `containers_total`, its `intercepts` rows, `cpu_percent` and `mem_mib`
   * (null when unmeasured), `started_at` and `started_by` (what started it:
   * `up`, `gate`, `restart` or `person`), and `crash_loops`.
   */
  features: FeatureSnapshot[];
  /** Features queued for capacity, first in line first. */
  waiting: string[];
  /** The registry's build and package caches: `name`, `kind` (`volume` or `host`), `source`, `exists`, `size_bytes` and `created_at`. */
  caches: CacheSnapshot[];
  /** Counts rolled up from the fields above. */
  summary: {
    /** Features holding a slot. */
    total_features: number;
    /** Slots still free for another feature. */
    available_slots: number;
    /** At least one infra container is up and every one is healthy or running. */
    infra_healthy: boolean;
    /** k8s forwards whose health check passes. */
    k8s_alive: number;
    /** k8s forwards declared. */
    k8s_total: number;
    /** Telepresence could be asked for its intercepts. */
    telepresence_available: boolean;
    /** Local services currently intercepted, across every feature. */
    intercepts_active: number;
  };
}

/** Feature vitals keyed by compose project; `projects` keys are `werkmeister-<feature>`. */
export interface FeatureVitals {
  health: Map<string, ProjectHealth>;
  /** Null when the sweep failed. */
  resources: WorkspaceResources | null;
}

/** One listing for health and one stats sweep for every feature, run side by side. */
export async function featureVitals(): Promise<FeatureVitals> {
  const [health, resources] = await Promise.all([
    projectContainers().then((all) => projectHealth(all ?? [])),
    getWorkspaceResources().catch(() => null),
  ]);
  return { health, resources };
}

/**
 * Reports everything `werkmeister feature status` knows in one machine-readable
 * read: shared infrastructure, the dashboard server, k8s port-forwards, every
 * running workspace with its containers, usage and intercepts, the queue
 * waiting for capacity, and the build caches. Runs in-process; it shells out
 * to docker and `telepresence`, and asks the werkmeister daemon for the
 * waiting queue when the daemon is running.
 *
 * @returns See {@link StatusSnapshot}. A failed docker stats sweep or cache
 *   read leaves those fields null or empty instead of failing the call.
 * @throws {@link SandboxError} when the daemon took the waiting-queue call but
 *   failed it or did not answer in time.
 *
 * @example
 * ```ts
 * import { statusSnapshot } from "werkmeister-core/sdk";
 *
 * const { features, summary } = await statusSnapshot();
 * const looping = features.filter((f) => f.crash_loops.length > 0);
 * console.log(`${summary.total_features} running, infra healthy: ${summary.infra_healthy}`);
 * for (const f of looping) console.log(`${f.name} is crash-looping`);
 * ```
 */
export async function statusSnapshot(): Promise<StatusSnapshot> {
  const vitals = featureVitals();
  // A missing or old registry must not cost the rest of status.
  const caches = cacheSnapshots().catch(() => []);
  const infra = await getInfraStatus();
  const k8s = await getPerServiceStatus();
  const allSlots = await getAllSlots();
  const mcp = await webStatus();

  // Same intercept data as `--intercepts`, grouped per feature so this stays the
  // one place system state is described.
  const interceptState = await listIntercepts(STATUS_READ);
  const interceptRows = buildInterceptRows(allSlots, loadServices(), interceptState);

  const { health, resources } = await vitals;
  const features: FeatureSnapshot[] = [];
  for (const [featureName, featureInfo] of sortedSlots(allSlots)) {
    const containers = tallied(await getContainerStatus(featureName));
    const project = await liveProject(featureName);
    const usage = resources?.projects[project];
    const h = health.get(project);
    features.push({
      name: featureName,
      slot: featureInfo.slot,
      services: featureInfo.services ?? [],
      port_range: featurePortRange(featureInfo.slot),
      containers,
      containers_running: containers.filter((c) => c.status === "running").length,
      containers_total: containers.length,
      intercepts: interceptRows.filter((r) => r.feature === featureName),
      cpu_percent: usage?.cpuPercent ?? null,
      mem_mib: usage?.memMib ?? null,
      started_at: h?.started?.at ?? null,
      started_by: h?.started?.by ?? null,
      crash_loops: h?.crashLoops ?? [],
    });
  }

  return {
    host: resources?.host ?? null,
    infrastructure: infra,
    mcp_web_server: mcp,
    k8s_forwards: k8s,
    features,
    waiting: await waitingQueue(),
    caches: await caches,
    summary: {
      total_features: features.length,
      available_slots: slotCount() - features.length,
      infra_healthy:
        infra.length > 0 && infra.every((c) => c.display === "healthy" || c.display === "running"),
      k8s_alive: k8s.filter((s) => s.status === "alive").length,
      k8s_total: k8s.length,
      telepresence_available: interceptState.available,
      intercepts_active: interceptRows.filter((r) => r.intercepted).length,
    },
  };
}
