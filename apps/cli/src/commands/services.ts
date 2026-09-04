/**
 * sandbox services <feature>
 *
 * List all services for a feature with their endpoints -- whether they
 * are running locally (with port) or via k8s port-forward.
 */

import { Colors, info, warn } from "../lib/config.js";
import { SandboxError } from "sandbox-core/errors";
import { featureServices, type FeatureServices, type ServiceEndpoint } from "sandbox-core/slots";

/**
 * The Source column, colour and all.
 *
 * The trailing spaces are part of each literal because `padEnd` counts the
 * escape sequences; they are what make the column line up on screen.
 */
const SOURCE_CELL: Record<ServiceEndpoint["source"], string> = {
  local: `${Colors.GREEN}local${Colors.RESET}  `,
  k8s: `${Colors.CYAN}k8s${Colors.RESET}    `,
  none: `${Colors.DIM}N/A${Colors.RESET}    `,
};

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;

  console.log(`\n${Colors.BOLD}=== Services for: ${feature} ===${Colors.RESET}\n`);

  let services: FeatureServices;
  try {
    services = await featureServices(feature);
  } catch (e) {
    // Not an error for this verb: asking what a stopped feature exposes is a
    // fair question, and the answer is "start it". Every other code propagates.
    if (e instanceof SandboxError && e.code === "NOT_RUNNING") {
      warn(e.message);
      info("Start it with: sandbox up " + feature);
      console.log();
      return;
    }
    throw e;
  }

  // Table header
  console.log(
    `  ${Colors.BOLD}${"Service".padEnd(25)}  ` +
      `${"Source".padEnd(8)}  ` +
      `${"Endpoint".padEnd(30)}  ` +
      `${"Type".padEnd(15)}${Colors.RESET}`,
  );
  console.log(`  ${"─".repeat(82)}`);

  for (const { service, source, endpoint, type } of services.endpoints) {
    console.log(
      `  ${service.padEnd(25)}  ` +
        `${SOURCE_CELL[source]}  ` +
        `${(endpoint ?? "(not configured)").padEnd(30)}  ` +
        `${Colors.DIM}${type}${Colors.RESET}`,
    );
  }

  console.log();
  console.log(
    `  ${Colors.GREEN}local${Colors.RESET} = running in Docker on this machine  ` +
      `|  ${Colors.CYAN}k8s${Colors.RESET} = port-forwarded from k8s cluster`,
  );
  console.log();
}
