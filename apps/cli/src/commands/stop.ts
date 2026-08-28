/**
 * sandbox stop <feature>
 *
 * Stop containers for a feature without removing them or releasing the slot.
 * The feature can be resumed with ``sandbox restart <feature>`` or
 * ``sandbox up <feature>``.
 *
 * For shared infrastructure use ``sandbox stop infra``.
 */

import { Colors, error, info } from "../lib/config.js";
import { composeStop } from "sandbox-core/compose";
import { loadDotenv } from "../lib/dotenv.js";
import { stop as infraStop } from "sandbox-core/infra";
import { getSlot } from "sandbox-core/slots";

export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  if (feature === "infra") {
    await infraStop();
    return;
  }

  console.log(`\n${Colors.BOLD}=== sandbox stop: ${feature} ===${Colors.RESET}\n`);

  const slot = await getSlot(feature);
  if (slot === null) {
    error(`Feature '${feature}' is not running (no slot allocated)`);
    info(`Start it with: sandbox up ${feature}`);
    process.exit(1);
  }

  info(`Stopping containers for '${feature}' (slot ${slot})...`);
  const ok = composeStop(feature);

  if (ok) {
    console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' stopped${Colors.RESET}\n`);
    console.log(
      `  ${Colors.DIM}Slot ${slot} preserved — resume with: sandbox restart ${feature}${Colors.RESET}`,
    );
    console.log(
      `  ${Colors.DIM}To fully tear down:              sandbox down ${feature}${Colors.RESET}`,
    );
    console.log();
  } else {
    error(`Failed to stop containers for '${feature}'`);
    process.exit(1);
  }
}
