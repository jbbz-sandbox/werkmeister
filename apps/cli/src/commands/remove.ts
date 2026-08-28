/**
 * sandbox remove <feature> <service>
 *
 * Remove a local service from a feature, falling back to k8s for that
 * service. Re-generates compose and proxy configuration.
 */

import { isCaddyRunning, reloadCaddy } from "sandbox-core/caddy";
import { Colors, error, info, loadPorts, loadServices, warn } from "../lib/config.js";
import { composeDown, composeUp } from "sandbox-core/compose";
import {
  generateCaddyfile,
  generateFeatureCompose,
  generateFeatureEnv,
  generateSupergraphConfig,
} from "sandbox-core/generate";
import { getAllSlots, getSlot } from "sandbox-core/slots";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;
  const service = args.service as string;

  console.log(`\n${Colors.BOLD}=== sandbox remove: ${service} from ${feature} ===${Colors.RESET}\n`);

  const servicesConfig = loadServices();
  const portsConfig = loadPorts();
  const config = { services: servicesConfig, ports: portsConfig };

  const slot = await getSlot(feature);
  if (slot === null) {
    error(`Feature '${feature}' is not running (no slot allocated)`);
    process.exit(1);
  }

  // Get current services
  const allSlots = await getAllSlots();
  const featureInfo = allSlots[feature] as any;
  const currentServices: string[] =
    featureInfo && typeof featureInfo === "object" && !Array.isArray(featureInfo)
      ? [...(featureInfo.services ?? [])]
      : [];

  if (!currentServices.includes(service)) {
    warn(`Service '${service}' is not running locally for '${feature}'`);
    if (currentServices.length) {
      console.log(
        `  ${Colors.DIM}Local services: ${[...currentServices].sort().join(", ")}${Colors.RESET}`,
      );
    } else {
      console.log(`  ${Colors.DIM}No local services running${Colors.RESET}`);
    }
    console.log();
    return;
  }

  // Remove the service
  currentServices.splice(currentServices.indexOf(service), 1);
  info(`Removed '${service}' from local services -- will fall back to k8s`);

  // Re-generate config
  info("Regenerating configuration files...");
  generateFeatureCompose(feature, slot, currentServices, config);
  generateFeatureEnv(feature, slot, currentServices, config);
  generateSupergraphConfig(feature, slot, currentServices, config);

  // Restart containers (this will remove the service's container)
  if (currentServices.length) {
    info("Restarting containers...");
    composeUp(feature);
  } else {
    info("No local services remaining -- containers will be stopped");
    composeDown(feature);
  }

  // Update proxy
  info("Updating reverse proxy...");
  await generateCaddyfile(null, config);
  if (isCaddyRunning()) {
    await reloadCaddy();
  }

  // Summary
  console.log(`\n${Colors.GREEN}${Colors.BOLD}Service '${service}' removed from '${feature}'${Colors.RESET}`);
  console.log(`  ${Colors.CYAN}'${service}' now served via k8s port-forward${Colors.RESET}`);
  if (currentServices.length) {
    console.log(
      `  ${Colors.DIM}Remaining local services: ${[...currentServices].sort().join(", ")}${Colors.RESET}`,
    );
  } else {
    console.log(`  ${Colors.DIM}No local services -- all traffic goes to k8s${Colors.RESET}`);
  }
  console.log();
}
