/**
 * sandbox status
 *
 * Show shared infra, active features, and k8s port-forward health in one view.
 */

import { getContainerStatus } from "werkmeister-core/compose";
import { type ForwardStatus, getPerServiceStatus } from "werkmeister-core/k8s";
import { getAllSlots, type SlotEntry, slotCount } from "werkmeister-core/slots";
import {
  buildInterceptRows,
  featurePortRange,
  finishedSetup,
  getInfraStatus,
  type InfraContainer,
  type InterceptRow,
  interceptsSnapshot,
  sortedSlots,
  statusSnapshot,
  tallied,
} from "werkmeister-core/status";
import { listIntercepts } from "werkmeister-core/telepresence";
import { type WebServerStatus, status as webStatus } from "werkmeister-core/web_servers";
import { Colors, loadServices } from "../lib/config.js";

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
      `         ${color}  -> ${cName}: ${cStatus}${Colors.RESET}` + (cPorts ? `  [${cPorts}]` : ""),
    );
  }
}

/**
 * One line per active intercept, under its feature. Silent when nothing is
 * intercepted — `status` shouldn't grow noise for a feature most runs don't use.
 */
function printFeatureIntercepts(rows: InterceptRow[]): void {
  for (const r of rows.filter((x) => x.intercepted)) {
    const owner = r.intercepted_by === null ? "owner unknown" : `x-feature: ${r.intercepted_by}`;
    console.log(
      `         ${Colors.GREEN}  ⇄ ${r.service} intercepted${Colors.RESET} ${Colors.DIM}(${owner})${Colors.RESET}`,
    );
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

/** Handle `sandbox status --intercepts`: focused Telepresence intercept view. */
async function runInterceptsOnly(asJson: boolean): Promise<void> {
  const snapshot = await interceptsSnapshot();

  if (asJson) {
    process.stdout.write(JSON.stringify(snapshot, null, 2));
    console.log();
    return;
  }

  console.log(`\n${Colors.BOLD}=== Telepresence Intercepts ===${Colors.RESET}\n`);
  if (!snapshot.available) {
    console.log(
      `  ${Colors.DIM}telepresence unavailable — nothing can be intercepted.${Colors.RESET}`,
    );
    console.log();
    return;
  }
  console.log(
    `  ${Colors.CYAN}Connected namespace:${Colors.RESET} ${snapshot.connected_namespace ?? "(none)"}\n`,
  );
  printInterceptRows(snapshot.intercepts);
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
      label =
        `${Colors.GREEN}active${Colors.RESET}` +
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

  if (args.json) {
    process.stdout.write(JSON.stringify(await statusSnapshot(), null, 2));
    console.log();
    return;
  }

  const infra = getInfraStatus();
  const k8s = await getPerServiceStatus();
  const allSlots = await getAllSlots();
  const mcp = await webStatus();

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
  const available = slotCount() - totalFeatures;
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
