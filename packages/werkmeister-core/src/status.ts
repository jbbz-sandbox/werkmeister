/**
 * The computing half of `sandbox status`: the collectors and the machine-readable
 * snapshot, with no rendering.
 *
 * The boundary is §4's: what derives state lives here, what formats it stays in
 * the CLI command. Every `print*` function and the argv branching are still
 * there, and nothing in this module writes to stdout.
 *
 * `StatusSnapshot` is snake_case on purpose. It *is* `sandbox status --json`'s
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

import { getAllSlots, getPortRange, type SlotEntry, slotCount } from "./slots.js";
import {
  _run,
  type InterceptState,
  interceptBlocker,
  isRemoteService,
  listIntercepts,
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
 * Runner for the telepresence reads below, capped well under `_run`'s 120s
 * default.
 *
 * They are `spawnSync`, so an in-process caller — the VS Code extension, the
 * dashboard server — has its whole event loop blocked for however long a wedged
 * daemon takes to answer, not just the one request waiting on it. 120s of that
 * is a hung app; 15s is a slow refresh. The cap lives here rather than at the
 * call sites because every reader of a *status view* wants it, `sandbox status`
 * included — and because an in-process caller no longer gets it for free from
 * the 15s timeout on a CLI child.
 *
 * ponytail: one number for every read. Split it if they ever need to differ.
 */
const STATUS_READ = (cmd: string[]) => _run(cmd, 15);

/** What `sandbox status --intercepts --json` prints. */
export interface InterceptsSnapshot {
  available: boolean;
  /** Telepresence is on PATH, connected or not: a disconnected install can still intercept (SW-12). */
  installed: boolean;
  connected_namespace: string | null;
  intercepts: InterceptRow[];
  /**
   * Registry services with k8s coordinates, sorted. Present even when telepresence
   * isn't, so a UI can hide the intercept control on local-only services (SW-21).
   */
  remote_services: string[];
}

export async function interceptsSnapshot(): Promise<InterceptsSnapshot> {
  const state = listIntercepts(STATUS_READ);
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

export interface StatusSnapshot {
  /** Null when the stats sweep failed. */
  host: HostSummary | null;
  infrastructure: InfraContainer[];
  mcp_web_server: WebServerStatus;
  k8s_forwards: ForwardStatus[];
  features: FeatureSnapshot[];
  /** SW-69: the registry's build and package caches. */
  caches: CacheSnapshot[];
  summary: {
    total_features: number;
    available_slots: number;
    infra_healthy: boolean;
    k8s_alive: number;
    k8s_total: number;
    telepresence_available: boolean;
    intercepts_active: number;
  };
}

/** Feature vitals keyed by compose project; `projects` keys are `sandbox-<feature>`. */
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

/** Everything `sandbox status` knows, in one machine-readable read. */
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
  const interceptState = listIntercepts(STATUS_READ);
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
