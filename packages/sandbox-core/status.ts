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

import * as fs from "node:fs";
import * as path from "node:path";

import { getContainerStatus, isOneShotService, type ContainerStatus } from "./compose.js";
import { infraRoot, loadServices } from "./config.js";
import { getPerServiceStatus, type ForwardStatus } from "./k8s.js";
import { ProcError, run as procRun } from "./proc.js";
// The only core module that reaches into `sandbox.ts`, for a one-line predicate
// whose other caller already lives there. Splitting it out would touch a second
// module for no gain.

import { getAllSlots, getPortRange, slotCount, type SlotEntry } from "./slots.js";
import {
  _run,
  connectedNamespace,
  interceptBlocker,
  listIntercepts,
  type InterceptState,
} from "./telepresence.js";
import { status as webStatus, type WebServerStatus } from "./web_servers.js";

export interface InfraContainer {
  service: string;
  display: string;
}

/** Return status of shared-infra containers without noisy logging. */
export function getInfraStatus(): InfraContainer[] {
  const composeFile = path.join(infraRoot(), "compose", "shared-infra.yml");
  if (!fs.existsSync(composeFile)) {
    return [];
  }
  try {
    const result = procRun(
      ["docker", "compose", "-f", composeFile, "ps", "--format", "json"],
      { capture: true, timeout: 10 },
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      return [];
    }
    const containers: InfraContainer[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      try {
        const data = JSON.parse(line);
        const state = data["State"] ?? "";
        const health = data["Health"] ?? "";
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
        containers.push({
          service: data["Service"] ?? "unknown",
          display,
        });
      } catch {
        continue;
      }
    }
    return containers;
  } catch (e) {
    if (e instanceof ProcError && (e.code === "ETIMEDOUT" || e.code === "ENOENT")) {
      return [];
    }
    throw e;
  }
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
 * claudeck server — has its whole event loop blocked for however long a wedged
 * daemon takes to answer, not just the one request waiting on it. 120s of that
 * is a hung app; 15s is a slow refresh. The cap lives here rather than at the
 * call sites because every reader of a *status view* wants it, `sandbox status`
 * included — and because claudeck used to get it for free from the 15s timeout
 * on the CLI child it no longer spawns.
 *
 * ponytail: one number for every read. Split it if they ever need to differ.
 */
const STATUS_READ = (cmd: string[]) => _run(cmd, 15);

/** What `sandbox status --intercepts --json` prints. */
export interface InterceptsSnapshot {
  available: boolean;
  connected_namespace: string | null;
  intercepts: InterceptRow[];
}

export async function interceptsSnapshot(): Promise<InterceptsSnapshot> {
  const state = listIntercepts(STATUS_READ);
  // Rows before the namespace probe: `--intercepts` has always shelled out in
  // that order, and both are reads of the same live telepresence state.
  const intercepts = buildInterceptRows(await getAllSlots(), loadServices(), state);
  return {
    available: state.available,
    connected_namespace: state.available ? connectedNamespace(STATUS_READ) : null,
    intercepts,
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
}

export interface StatusSnapshot {
  infrastructure: InfraContainer[];
  mcp_web_server: WebServerStatus;
  k8s_forwards: ForwardStatus[];
  features: FeatureSnapshot[];
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

/** Everything `sandbox status` knows, in one machine-readable read. */
export async function statusSnapshot(): Promise<StatusSnapshot> {
  const infra = getInfraStatus();
  const k8s = await getPerServiceStatus();
  const allSlots = await getAllSlots();
  const mcp = await webStatus();

  // Same intercept data as `--intercepts`, grouped per feature so this stays the
  // one place system state is described.
  const interceptState = listIntercepts(STATUS_READ);
  const interceptRows = buildInterceptRows(allSlots, loadServices(), interceptState);

  const features: FeatureSnapshot[] = [];
  for (const [featureName, featureInfo] of sortedSlots(allSlots)) {
    const containers = tallied(getContainerStatus(featureName) ?? []);
    features.push({
      name: featureName,
      slot: featureInfo.slot,
      services: featureInfo.services ?? [],
      port_range: featurePortRange(featureInfo.slot),
      containers,
      containers_running: containers.filter((c) => c.status === "running").length,
      containers_total: containers.length,
      intercepts: interceptRows.filter((r) => r.feature === featureName),
    });
  }

  return {
    infrastructure: infra,
    mcp_web_server: mcp,
    k8s_forwards: k8s,
    features,
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
