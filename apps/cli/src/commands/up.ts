/**
 * werkmeister up <feature>
 *
 * Starts containers for a feature workspace. Expects a compose.yml to
 * have been generated in the workspace root by 'werkmeister init-workspace'. If the
 * slot assigned at init time was released and is now taken by another feature,
 * the compose file is regenerated with a new slot before starting.
 *
 * The sequence itself is `werkmeister-core/lifecycle`; what is left here is argv,
 * the workspace resolution that depends on cwd, and the summary block.
 */

import type { UpResult } from "werkmeister-core/lifecycle";
import { up as upFeature } from "werkmeister-core/lifecycle";
import { Colors, error, resolveWorkspace } from "../lib/config.js";
import { loadDotenv } from "../lib/dotenv.js";
import { interruptSignal } from "../lib/interrupt.js";

/** The "Feature 'x' is ready" block — rendering, so it stays in the CLI. */
function printSummary(result: UpResult): void {
  const { feature, slot, portRange, localServices, urls, servicePorts } = result;
  const [portStart, portEnd] = portRange;
  if (result.waiting !== undefined) {
    console.log(
      `\n${Colors.CYAN}${Colors.BOLD}=== Feature '${feature}' is waiting for capacity (position ${result.waiting}) ===${Colors.RESET}\n` +
        "  It starts when another feature stops; `werkmeister status` shows the queue.\n",
    );
    return;
  }

  console.log(
    `\n${Colors.GREEN}${Colors.BOLD}=== Feature '${feature}' is ready ===${Colors.RESET}\n`,
  );
  console.log(
    `  ${Colors.CYAN}URL:${Colors.RESET}     ${urls.length ? urls.join(", ") : "(no routed hostname for these services)"}`,
  );
  console.log(`  ${Colors.CYAN}Cookie:${Colors.RESET}  X-Feature=${feature}`);
  console.log(`  ${Colors.CYAN}Slot:${Colors.RESET}    ${slot} (ports ${portStart}-${portEnd})`);
  console.log();

  if (localServices.length) {
    console.log(`  ${Colors.GREEN}Local services:${Colors.RESET}`);
    for (const { service, port } of servicePorts) {
      console.log(`    ${Colors.GREEN}*${Colors.RESET} ${service} -> localhost:${port}`);
    }
  } else {
    console.log(`  ${Colors.DIM}No local services (all traffic goes to k8s)${Colors.RESET}`);
  }

  console.log();
  console.log(`  ${Colors.DIM}k8s services: (everything not listed above)${Colors.RESET}`);
  console.log();
  console.log(`  ${Colors.DIM}Useful commands:${Colors.RESET}`);
  console.log("    werkmeister status            # view all features");
  console.log(`    werkmeister logs ${feature}    # tail logs`);
  console.log(`    werkmeister test ${feature}    # run Playwright tests`);
  console.log(`    werkmeister down ${feature}    # tear down`);
  console.log();
}

/** Execute the `werkmeister up <feature>` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  if (feature === "infra") {
    // `werkmeister up infra` is `werkmeister connect` — the command, not
    // `werkmeister-core/infra`'s `up()`, because this path prints connect's whole
    // rendering (banner, health table, tools block) and `up()` returns before
    // any of it. Imported as a literal so tsc resolves it: this call lived in
    // `infra.up()` behind a hoisted string constant until 353984e, which is
    // exactly why nothing noticed when step 3 moved that file and the path
    // stopped resolving (note 038).
    const connect = await import("./connect.js");
    await connect.run({});
    return;
  }

  const workspace = resolveWorkspace(feature, (args.workspace as string | null) ?? null);

  console.log(`\n${Colors.BOLD}=== werkmeister up: ${feature} ===${Colors.RESET}\n`);
  // The compose child inherits it; the template's idle gate reads it (SW-32).
  if (args.dev) process.env.WERKMEISTER_DEV = "1";

  // Every failure propagates: none of up's four codes carries a hint that has
  // to print between the error line and the exit, so main.ts's handler renders
  // them all as the `[err]` line these sites always produced.
  printSummary(await upFeature(feature, workspace, { signal: interruptSignal() }));
}
