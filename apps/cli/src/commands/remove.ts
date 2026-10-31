/**
 * werkmeister feature drop <feature> <service>
 *
 * Remove a local service from a feature, falling back to k8s for that
 * service. Re-generates compose and proxy configuration.
 *
 * The sequence itself is `werkmeister-core/lifecycle`; what is left here is the
 * banner, the two error renderings, and the summary block.
 */

import { SandboxError } from "werkmeister-core/errors";
import type { RemoveResult } from "werkmeister-core/lifecycle";
import { removeService } from "werkmeister-core/lifecycle";
import { getAllSlots } from "werkmeister-core/slots";
import { Colors, warn } from "../lib/config.js";

/**
 * The "not running locally" branch: a warning plus the feature's actual local
 * services, re-read here because the list is layout, not part of the failure.
 */
async function printNotLocal(feature: string, message: string): Promise<void> {
  warn(message);
  const local = (await getAllSlots())[feature]?.services ?? [];
  if (local.length) {
    console.log(`  ${Colors.DIM}Local services: ${[...local].sort().join(", ")}${Colors.RESET}`);
  } else {
    console.log(`  ${Colors.DIM}No local services running${Colors.RESET}`);
  }
  console.log();
}

/** The "Service 'x' removed" block — rendering, so it stays in the CLI. */
function printSummary(result: RemoveResult): void {
  const { feature, removed, remaining } = result;

  console.log(
    `\n${Colors.GREEN}${Colors.BOLD}Service '${removed}' removed from '${feature}'${Colors.RESET}`,
  );
  console.log(`  ${Colors.CYAN}'${removed}' now served via k8s port-forward${Colors.RESET}`);
  if (remaining.length) {
    console.log(`  ${Colors.DIM}Remaining local services: ${remaining.join(", ")}${Colors.RESET}`);
  } else {
    console.log(`  ${Colors.DIM}No local services -- all traffic goes to k8s${Colors.RESET}`);
  }
  console.log();
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const feature = args.feature as string;
  const service = args.service as string;

  console.log(
    `\n${Colors.BOLD}=== werkmeister remove: ${service} from ${feature} ===${Colors.RESET}\n`,
  );

  let result: RemoveResult;
  try {
    result = await removeService(feature, service);
  } catch (e) {
    // NOT_LOCAL is caught because it is not a failure the user has to act on —
    // it prints its warning and exits 0, as the early `return` it replaced did.
    // NOT_RUNNING propagates: main.ts renders the same `[err]` line and exit 1.
    if (e instanceof SandboxError && e.code === "NOT_LOCAL") {
      await printNotLocal(feature, e.message);
      return;
    }
    throw e;
  }

  printSummary(result);
}
