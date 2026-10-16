/**
 * sandbox stop <feature>
 *
 * Stop containers for a feature without removing them or releasing the slot.
 * The feature can be resumed with ``sandbox restart <feature>`` or
 * ``sandbox up <feature>``.
 *
 * For shared infrastructure use ``sandbox stop infra``.
 */

import { SandboxError } from "sandbox-core/errors";
import { stop as infraStop } from "sandbox-core/infra";
import { stop as stopFeature } from "sandbox-core/lifecycle";
import { Colors, error, info } from "../lib/config.js";
import { loadDotenv } from "../lib/dotenv.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  console.log(`\n${Colors.BOLD}=== sandbox stop: ${feature} ===${Colors.RESET}\n`);

  if (feature === "infra") {
    await infraStop();
    console.log();
    return;
  }

  let slot: number;
  try {
    ({ slot } = await stopFeature(feature));
  } catch (e) {
    // Reported here rather than by main.ts's handler because the hint has to
    // land *between* the error line and the exit, and the handler only knows
    // how to print the message. Every other code propagates.
    if (e instanceof SandboxError && e.code === "NOT_RUNNING") {
      error(e.message);
      info(`Start it with: sandbox up ${feature}`);
      process.exit(1);
    }
    throw e;
  }

  console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' stopped${Colors.RESET}\n`);
  console.log(
    `  ${Colors.DIM}Slot ${slot} preserved — resume with: sandbox restart ${feature}${Colors.RESET}`,
  );
  console.log(
    `  ${Colors.DIM}To fully tear down:              sandbox down ${feature}${Colors.RESET}`,
  );
  console.log();
}
