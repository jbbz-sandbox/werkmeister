/**
 * sandbox status
 *
 * Show shared infra, active features, and k8s port-forward health in one view.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors, getInfraRoot, loadServices } from "../lib/config.js";
import { getContainerStatus, type ContainerStatus } from "../lib/docker.js";
import { isOneShotService } from "sandbox-core";
import { getPerServiceStatus, type ForwardStatus } from "sandbox-core/k8s";
import { status as webStatus, type WebServerStatus } from "../lib/web_servers.js";
import { getAllSlots, getPortRange, type SlotEntry } from "sandbox-core/slots";
import { ProcError, run as procRun } from "sandbox-core/proc";
import {
  connectedNamespace,
  interceptBlocker,
  listIntercepts,
  type InterceptState,
} from "../lib/telepresence.js";

interface InfraContainer {
  service: string;
  display: string;
}

/** Return status of shared-infra containers without noisy logging. */
function getInfraStatus(): InfraContainer[] {
  const composeFile = path.join(getInfraRoot(), "compose", "shared-infra.yml");
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

function printInfraSection(containers: InfraContainer[], mcp: WebServerStatus): void {
  console.log(`  ${Colors.BOLD}Infrastructure${Colors.RESET}`);
  console.log(`  ${Colors.BOLD}${"Service".padEnd(25)}  Status${Colors.RESET}`);
  console.log(`  ${"─".repeat(40)}`);
  if (!containers.length) {
    console.log(`  ${Colors.DIM}not running  (start with: sandbox connect)${Colors.RESET}`);
  } else {
    for (const c of containers) {
      const d = c.display;
      let color: string;
      if (d === "healthy") {
        color = Colors.GREEN;
      } else if (d === "starting" || d === "running") {
        color = Colors.YELLOW;
      } else {
        color = Colors.RED;
      }
      console.log(`  ${c.service.padEnd(25)}  ${color}${d}${Colors.RESET}`);
    }
  }

  // MCP web server (host process, not a container).
  let d: string;
  let color: string;
  if (mcp.running) {
    d = mcp.healthy ? "healthy" : "running";
    color = mcp.healthy ? Colors.GREEN : Colors.YELLOW;
  } else {
    d = "down";
    color = Colors.RED;
  }
  console.log(`  ${"mcp-web-server".padEnd(25)}  ${color}${d}${Colors.RESET}`);
  console.log();
}

function featurePortRange(slot: number | string): string {
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
function finishedSetup(c: ContainerStatus): boolean {
  return isOneShotService(c.service, c.role) && c.status === "exited" && c.exitCode === 0;
}

/** The containers a feature's up/down verdict is counted over. */
export function tallied(containers: ContainerStatus[]): ContainerStatus[] {
  return containers.filter((c) => !finishedSetup(c));
}

function featureStatus(featureName: string): string {
  const containers = tallied(getContainerStatus(featureName));
  if (!containers.length) {
    return `${Colors.DIM}no containers${Colors.RESET}`;
  }
  const running = containers.filter((c) => c.status === "running").length;
  const totalC = containers.length;
  if (running === totalC) {
    return `${Colors.GREEN}up (${running}/${totalC})${Colors.RESET}`;
  }
  if (running > 0) {
    return `${Colors.YELLOW}partial (${running}/${totalC})${Colors.RESET}`;
  }
  return `${Colors.RED}down (0/${totalC})${Colors.RESET}`;
}

function printVerboseContainers(featureName: string): void {
  const containers = getContainerStatus(featureName) ?? [];
  for (const c of containers) {
    const cName = c.name || "?";
    const cStatus = c.status || "?";
    const cPorts = c.ports || "";
    const color = cStatus === "running" ? Colors.GREEN : finishedSetup(c) ? Colors.DIM : Colors.RED;
    console.log(
      `         ${color}  -> ${cName}: ${cStatus}${Colors.RESET}` +
        (cPorts ? `  [${cPorts}]` : ""),
    );
  }
}

/** Sort feature entries by slot (missing/non-numeric slots sort last, as 99). */
function sortedSlots(allSlots: Record<string, SlotEntry>): [string, SlotEntry][] {
  return Object.entries(allSlots).sort((a, b) => {
    const sa = typeof a[1].slot === "number" ? a[1].slot : 99;
    const sb = typeof b[1].slot === "number" ? b[1].slot : 99;
    return sa - sb;
  });
}

/**
 * One line per active intercept, under its feature. Silent when nothing is
 * intercepted — `status` shouldn't grow noise for a feature most runs don't use.
 */
function printFeatureIntercepts(rows: InterceptRow[]): void {
  for (const r of rows.filter((x) => x.intercepted)) {
    const owner = r.intercepted_by === null ? "owner unknown" : `x-feature: ${r.intercepted_by}`;
    console.log(`         ${Colors.GREEN}  ⇄ ${r.service} intercepted${Colors.RESET} ${Colors.DIM}(${owner})${Colors.RESET}`);
  }
}

function printFeaturesSection(
  allSlots: Record<string, SlotEntry>,
  verbose: boolean,
  interceptRows: InterceptRow[],
): number {
  console.log(`  ${Colors.BOLD}Features${Colors.RESET}`);

  const entries = Object.entries(allSlots);
  if (!entries.length) {
    console.log(
      `  ${Colors.DIM}No active features.  Start one with: sandbox up <feature>${Colors.RESET}`,
    );
    console.log();
    return 0;
  }

  console.log(
    `  ${Colors.BOLD}` +
      `${"Slot".padStart(4)}  ${"Feature".padEnd(25)}  ${"Services".padEnd(35)}  ${"Ports".padEnd(15)}  Status` +
      `${Colors.RESET}`,
  );
  console.log(`  ${"─".repeat(95)}`);

  for (const [featureName, featureInfo] of sortedSlots(allSlots)) {
    const slot = featureInfo.slot;
    const services = featureInfo.services ?? [];
    let svcStr = services.length ? services.join(", ") : "(none)";
    if (svcStr.length > 33) {
      svcStr = svcStr.slice(0, 30) + "...";
    }

    console.log(
      `  ${String(slot).padStart(4)}  ` +
        `${featureName.padEnd(25)}  ` +
        `${svcStr.padEnd(35)}  ` +
        `${featurePortRange(slot).padEnd(15)}  ` +
        `${featureStatus(featureName)}`,
    );

    if (verbose) {
      printVerboseContainers(featureName);
    }
    printFeatureIntercepts(interceptRows.filter((r) => r.feature === featureName));
  }

  console.log();
  return entries.length;
}

// ---------------------------------------------------------------------------
// Intercepts (`--intercepts`)
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

/** Handle `sandbox status --intercepts`: focused Telepresence intercept view. */
async function runInterceptsOnly(asJson: boolean): Promise<void> {
  const state = listIntercepts();
  const rows = buildInterceptRows(await getAllSlots(), loadServices(), state);
  const namespace = state.available ? connectedNamespace() : null;

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { available: state.available, connected_namespace: namespace, intercepts: rows },
        null,
        2,
      ),
    );
    console.log();
    return;
  }

  console.log(`\n${Colors.BOLD}=== Telepresence Intercepts ===${Colors.RESET}\n`);
  if (!state.available) {
    console.log(`  ${Colors.DIM}telepresence unavailable — nothing can be intercepted.${Colors.RESET}`);
    console.log();
    return;
  }
  console.log(`  ${Colors.CYAN}Connected namespace:${Colors.RESET} ${namespace ?? "(none)"}\n`);
  printInterceptRows(rows);
}

function printInterceptRows(rows: InterceptRow[]): void {
  if (!rows.length) {
    console.log(`  ${Colors.DIM}No active features.${Colors.RESET}`);
    console.log();
    return;
  }
  console.log(
    `  ${Colors.BOLD}${"Feature".padEnd(25)}  ${"Service".padEnd(25)}  Intercept${Colors.RESET}`,
  );
  console.log(`  ${"─".repeat(70)}`);
  for (const r of rows) {
    let label: string;
    if (r.intercepted) {
      label = `${Colors.GREEN}active${Colors.RESET}` +
        (r.intercepted_by === null
          ? ` ${Colors.DIM}(owner unknown)${Colors.RESET}`
          : ` ${Colors.DIM}(x-feature: ${r.intercepted_by})${Colors.RESET}`);
    } else if (r.interceptable) {
      label = `${Colors.DIM}off${Colors.RESET}`;
    } else {
      label = `${Colors.DIM}n/a${Colors.RESET}`;
    }
    console.log(`  ${r.feature.padEnd(25)}  ${r.service.padEnd(25)}  ${label}`);
  }
  console.log();
}

/** Print per-service k8s port-forward health. Returns count of alive forwards. */
function printK8sSection(services: ForwardStatus[]): number {
  console.log(`  ${Colors.BOLD}k8s Port-Forwards${Colors.RESET}`);

  if (!services.length) {
    console.log(`  ${Colors.DIM}not running  (start with: sandbox connect)${Colors.RESET}`);
    console.log();
    return 0;
  }

  if (services[0].status === "container_down") {
    console.log(`  ${Colors.RED}container sandbox-k8s-forwards is down${Colors.RESET}`);
    console.log(`  ${Colors.DIM}Run 'sandbox connect' to start all infrastructure.${Colors.RESET}`);
    console.log();
    return 0;
  }

  console.log(
    `  ${Colors.BOLD}` +
      `${"Service".padEnd(25)}  ${"Ports".padEnd(17)}  ${"Health check".padEnd(28)}  Status` +
      `${Colors.RESET}`,
  );
  console.log(`  ${"─".repeat(85)}`);

  let alive = 0;
  for (const svc of services) {
    const s = svc.status;
    let color: string;
    let label: string;
    if (s === "alive") {
      color = Colors.GREEN;
      label = "alive";
      alive += 1;
    } else if (s === "dead") {
      color = Colors.RED;
      label = "dead";
    } else {
      color = Colors.YELLOW;
      label = "unknown";
    }

    const portMap = `:${svc.listen_port} → :${svc.remote_port}`;
    const healthCol = svc.health_path ? svc.health_path : "(tcp)";
    console.log(
      `  ${svc.name.padEnd(25)}  ${portMap.padEnd(17)}  ${healthCol.padEnd(28)}  ${color}${label}${Colors.RESET}`,
    );
  }

  console.log();
  return alive;
}

/** Emit a machine-readable JSON snapshot for agent-driven diagnosis. */
function runJson(
  infra: InfraContainer[],
  k8s: ForwardStatus[],
  allSlots: Record<string, SlotEntry>,
  mcp: WebServerStatus,
): void {
  // Same intercept data as `--intercepts`, grouped per feature so this stays the
  // one place system state is described.
  const interceptState = listIntercepts();
  const interceptRows = buildInterceptRows(allSlots, loadServices(), interceptState);

  const features: Record<string, unknown>[] = [];
  for (const [featureName, featureInfo] of sortedSlots(allSlots)) {
    const slot = featureInfo.slot;
    const services = featureInfo.services ?? [];
    let portRange: string;
    if (typeof slot === "number") {
      const [portStart, portEnd] = getPortRange(slot);
      portRange = `${portStart}-${portEnd}`;
    } else {
      portRange = "?";
    }
    const containers: ContainerStatus[] = tallied(getContainerStatus(featureName) ?? []);
    const running = containers.filter((c) => c.status === "running").length;
    features.push({
      name: featureName,
      slot,
      services,
      port_range: portRange,
      containers,
      containers_running: running,
      containers_total: containers.length,
      intercepts: interceptRows.filter((r) => r.feature === featureName),
    });
  }

  const k8sAlive = k8s.filter((s) => s.status === "alive").length;
  const infraHealthy =
    infra.length > 0 && infra.every((c) => c.display === "healthy" || c.display === "running");

  const output = {
    infrastructure: infra,
    mcp_web_server: mcp,
    k8s_forwards: k8s,
    features,
    summary: {
      total_features: features.length,
      available_slots: 12 - features.length,
      infra_healthy: infraHealthy,
      k8s_alive: k8sAlive,
      k8s_total: k8s.length,
      telepresence_available: interceptState.available,
      intercepts_active: interceptRows.filter((r) => r.intercepted).length,
    },
  };
  process.stdout.write(JSON.stringify(output, null, 2));
  console.log();
}

/** Handle `sandbox status --k8s`: focused k8s port-forward view. */
function runK8sOnly(k8s: ForwardStatus[], asJson: boolean): void {
  if (asJson) {
    const k8sAlive = k8s.filter((s) => s.status === "alive").length;
    process.stdout.write(
      JSON.stringify(
        { k8s_forwards: k8s, summary: { k8s_alive: k8sAlive, k8s_total: k8s.length } },
        null,
        2,
      ),
    );
    console.log();
    return;
  }

  console.log(`\n${Colors.BOLD}=== k8s Port-Forward Status ===${Colors.RESET}\n`);
  const alive = printK8sSection(k8s);
  const total = k8s.length;
  if (total) {
    console.log(`  ${alive}/${total} services alive`);
    console.log();
  }
  if (alive < total) {
    console.log(
      `  ${Colors.YELLOW}To restart dead forwards: docker restart sandbox-k8s-forwards${Colors.RESET}`,
    );
    console.log();
  }
}

/** Execute the `sandbox status` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.k8s) {
    runK8sOnly(await getPerServiceStatus(), Boolean(args.json));
    return;
  }

  if (args.intercepts) {
    await runInterceptsOnly(Boolean(args.json));
    return;
  }

  const infra = getInfraStatus();
  const k8s = await getPerServiceStatus();
  const allSlots = await getAllSlots();
  const mcp = await webStatus();

  if (args.json) {
    runJson(infra, k8s, allSlots, mcp);
    return;
  }

  console.log(`\n${Colors.BOLD}=== Developer Sandbox Status ===${Colors.RESET}\n`);

  printInfraSection(infra, mcp);
  printFeaturesSection(
    allSlots,
    Boolean(args.verbose),
    buildInterceptRows(allSlots, loadServices(), listIntercepts()),
  );
  const alive = printK8sSection(k8s);

  // Summary
  const totalFeatures = Object.keys(allSlots).length;
  const available = 12 - totalFeatures;
  const k8sTotal = k8s.length;
  let k8sColor: string;
  if (alive === k8sTotal) {
    k8sColor = Colors.GREEN;
  } else if (alive > 0) {
    k8sColor = Colors.YELLOW;
  } else {
    k8sColor = Colors.RED;
  }
  console.log(
    `  ${Colors.CYAN}${totalFeatures} active feature(s), ${available} slot(s) available${Colors.RESET}` +
      `  |  k8s: ${k8sColor}${alive}/${k8sTotal} alive${Colors.RESET}`,
  );
  console.log();

  if (alive < k8sTotal) {
    console.log(
      `  ${Colors.YELLOW}To restart dead forwards: ` +
        `docker restart sandbox-k8s-forwards${Colors.RESET}`,
    );
    console.log();
  }
}
