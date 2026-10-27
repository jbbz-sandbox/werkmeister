/**
 * werkmeister pause <feature>
 *
 * Freeze a feature's running containers and hold its Claude session until
 * `werkmeister resume` (SW-70).
 */

import { SandboxError } from "werkmeister-core/errors";
import { pause } from "werkmeister-core/lifecycle";
import { Colors, error, info } from "../lib/config.js";
import { loadDotenv } from "../lib/dotenv.js";

/** The feature from the argument or the cwd's `.env`; exits on none, or on `infra`. */
export function featureArg(args: Record<string, unknown>, verb: string): string {
  const feature = (args.feature as string | null) || loadDotenv(process.cwd())["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }
  if (feature === "infra") {
    error(`${verb} the infra stack is not supported: every workspace shares it.`);
    process.exit(1);
  }
  return feature;
}

/** Report a coded failure with its hint, as restart.ts does; anything else propagates. */
export function reportHint(e: unknown, hints: Record<string, string>): void {
  if (e instanceof SandboxError && hints[e.code]) {
    error(e.message);
    info(hints[e.code]);
    process.exit(1);
  }
  throw e;
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = featureArg(args, "Pausing");
  console.log(`\n${Colors.BOLD}=== werkmeister pause: ${feature} ===${Colors.RESET}\n`);
  try {
    const { containers } = await pause(feature);
    console.log(
      `\n${Colors.GREEN}${Colors.BOLD}Paused '${feature}': ${containers.length} container(s) frozen, ` +
        `its Claude session is held.${Colors.RESET} Resume with: werkmeister resume ${feature}\n`,
    );
  } catch (e) {
    reportHint(e, {
      NOT_RUNNING: `Nothing to pause. Start it with: werkmeister up ${feature}`,
      ALREADY_PAUSED: `Resume it with: werkmeister resume ${feature}`,
      NO_WORKSPACE: "Run it from the workspace folder, or check: werkmeister list-workspaces",
      COMPOSE_PAUSE_FAILED: `Undo what did freeze with: werkmeister resume ${feature}`,
    });
  }
}
