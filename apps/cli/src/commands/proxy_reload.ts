/**
 * sandbox proxy-reload
 *
 * Regenerate the Caddyfile from all active features and reload the
 * Caddy reverse proxy container.
 *
 * The sequence itself is `sandbox-core/lifecycle`; what is left here is the
 * banner and the closing verdict. The "Features in Caddyfile" block is not
 * rendered here because it lands *between* the generate and the reload — the
 * library emits it, as `up` does with its "Local services" line.
 */

import { reloadProxy } from "sandbox-core/lifecycle";
import { Colors, error, success } from "../lib/config.js";

export async function run(_args: Record<string, unknown>): Promise<void> {
  console.log(`\n${Colors.BOLD}=== Proxy Reload ===${Colors.RESET}\n`);

  const { ok } = await reloadProxy({ start: true });

  if (ok) {
    success("Proxy configuration updated");
  } else {
    error(
      "Failed to update proxy -- see route-count/adapt errors above " +
        "and inspect ~/.sandbox/infra/proxy/Caddyfile.",
    );
  }

  console.log();
}
