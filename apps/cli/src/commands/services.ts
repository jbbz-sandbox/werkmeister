/**
 * sandbox services <feature>
 *
 * List all services for a feature with their endpoints -- whether they
 * are running locally (with port) or via k8s port-forward.
 */

import { Colors, info, loadServices, warn } from "../lib/config.js";
import { getAllSlots, getServicePort, getSlot } from "sandbox-core/slots";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;

  console.log(`\n${Colors.BOLD}=== Services for: ${feature} ===${Colors.RESET}\n`);

  const servicesConfig = loadServices();
  const slot = await getSlot(feature);

  if (slot === null) {
    warn(`Feature '${feature}' is not running (no slot allocated)`);
    info("Start it with: sandbox up " + feature);
    console.log();
    return;
  }

  // Get the feature's local services from Docker container labels
  const allSlots = await getAllSlots();
  const featureInfo = allSlots[feature] as any;
  const localServices =
    featureInfo && typeof featureInfo === "object" && !Array.isArray(featureInfo)
      ? featureInfo.services ?? []
      : [];

  // Table header
  console.log(
    `  ${Colors.BOLD}${"Service".padEnd(25)}  ` +
      `${"Source".padEnd(8)}  ` +
      `${"Endpoint".padEnd(30)}  ` +
      `${"Type".padEnd(15)}${Colors.RESET}`,
  );
  console.log(`  ${"─".repeat(82)}`);

  for (const svcName of Object.keys(servicesConfig).sort()) {
    const svcDef = servicesConfig[svcName] ?? {};
    if (!(typeof svcDef === "object" && svcDef !== null && !Array.isArray(svcDef))) {
      continue;
    }

    const svcType = svcDef["type"] ?? "unknown";

    let source: string;
    let endpoint: string;
    if (localServices.includes(svcName)) {
      const portOffset = svcDef["port_offset"] ?? 0;
      const port = getServicePort(slot, portOffset);
      source = `${Colors.GREEN}local${Colors.RESET}  `;
      endpoint = `localhost:${port}`;
    } else {
      const k8sPort = svcDef["k8s_forward_port"];
      if (k8sPort) {
        source = `${Colors.CYAN}k8s${Colors.RESET}    `;
        endpoint = `localhost:${k8sPort}`;
      } else {
        source = `${Colors.DIM}N/A${Colors.RESET}    `;
        endpoint = "(not configured)";
      }
    }

    console.log(
      `  ${svcName.padEnd(25)}  ` +
        `${source}  ` +
        `${endpoint.padEnd(30)}  ` +
        `${Colors.DIM}${svcType}${Colors.RESET}`,
    );
  }

  console.log();
  console.log(
    `  ${Colors.GREEN}local${Colors.RESET} = running in Docker on this machine  ` +
      `|  ${Colors.CYAN}k8s${Colors.RESET} = port-forwarded from k8s cluster`,
  );
  console.log();
}
