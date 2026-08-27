/**
 * sandbox proxy-reload
 *
 * Regenerate the Caddyfile from all active features and reload the
 * Caddy reverse proxy container.
 */

import { isCaddyRunning, reloadCaddy, startCaddy } from "sandbox-core/caddy";
import { Colors, error, info, loadPorts, loadServices, success, warn } from "../lib/config.js";
import { generateCaddyfile } from "sandbox-core/generate";
import { getAllSlots } from "sandbox-core/slots";

export async function run(_args: Record<string, unknown>): Promise<void> {
  console.log(`\n${Colors.BOLD}=== Proxy Reload ===${Colors.RESET}\n`);

  // Load config
  const servicesConfig = loadServices();
  const portsConfig = loadPorts();
  const config = { services: servicesConfig, ports: portsConfig };

  // Regenerate Caddyfile (re-reads slots under lock)
  info("Regenerating Caddyfile...");
  await generateCaddyfile(null, config);

  // List active features in the generated config
  const allFeatures = await getAllSlots();
  if (!Object.keys(allFeatures).length) {
    info("No active features in Caddyfile");
  }
  if (Object.keys(allFeatures).length) {
    console.log(`\n  ${Colors.CYAN}Features in Caddyfile:${Colors.RESET}`);
    for (const featName of Object.keys(allFeatures).sort()) {
      const featInfo = allFeatures[featName] as any;
      if (!(typeof featInfo === "object" && featInfo !== null && !Array.isArray(featInfo))) {
        continue;
      }
      const slot = featInfo.slot ?? "?";
      const services = featInfo.services ?? [];
      const svcStr = services.length ? services.join(", ") : "(no local services)";
      console.log(`    ${Colors.GREEN}*${Colors.RESET} ${featName} (slot ${slot}): ${svcStr}`);
    }
    console.log();
  }

  // Reload or start Caddy
  let ok: boolean;
  if (isCaddyRunning()) {
    info("Reloading Caddy...");
    ok = await reloadCaddy();
  } else {
    warn("Caddy is not running -- starting it...");
    ok = startCaddy();
  }

  if (ok) {
    success("Proxy configuration updated");
  } else {
    error(
      "Failed to update proxy -- see route-count/adapt errors above " +
        "and inspect infra/proxy/Caddyfile.",
    );
  }

  console.log();
}
