/**
 * sandbox restart <feature>
 *
 * Restart all containers for a feature's stack.
 */

import { Colors, error, info } from "../lib/config.js";
import { SandboxError } from "sandbox-core/errors";
import { loadDotenv } from "../lib/dotenv.js";
import { restart as infraRestart } from "sandbox-core/infra";
import { restart as restartFeature } from "sandbox-core/lifecycle";

export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  console.log(`\n${Colors.BOLD}=== sandbox restart: ${feature} ===${Colors.RESET}\n`);

  if (feature === "infra") {
    await infraRestart();
    console.log();
    return;
  }

  // Both hints land *between* the error line and the exit, which main.ts's
  // handler cannot reproduce — it only knows how to print the message. So the
  // codes that carry one report themselves; anything else propagates.
  const hints: Record<string, string> = {
    NOT_RUNNING: `Start it with: sandbox up ${feature}`,
    COMPOSE_RESTART_FAILED: `Check with: sandbox logs ${feature}`,
  };

  try {
    await restartFeature(feature);
  } catch (e) {
    if (e instanceof SandboxError && hints[e.code]) {
      error(e.message);
      info(hints[e.code]);
      process.exit(1);
    }
    throw e;
  }

  console.log(`\n${Colors.GREEN}${Colors.BOLD}Feature '${feature}' restarted${Colors.RESET}\n`);
}
