/**
 * sandbox logs <feature> [service]
 *
 * Tail docker compose logs for a feature, optionally filtered to a
 * specific service. Streams output until interrupted with Ctrl+C.
 */

import { Colors, warn } from "../lib/config.js";
import { composeLogs } from "sandbox-core/compose";
import { getSlot } from "sandbox-core/slots";

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;
  const service = (args.service as string | null) ?? null;

  const slot = await getSlot(feature);
  if (slot === null) {
    warn(`Feature '${feature}' is not running (no slot allocated)`);
    warn(`Start it with: sandbox up ${feature}`);
    return;
  }

  console.log(
    `\n${Colors.BOLD}=== Logs: ${feature}` +
      (service ? ` / ${service}` : "") +
      ` ===${Colors.RESET}\n`,
  );
  composeLogs(feature, service);
}
