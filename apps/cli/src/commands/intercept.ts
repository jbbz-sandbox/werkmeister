/**
 * sandbox intercept <feature> -s <service>
 *
 * Route a header-scoped slice of live k8s **dev** traffic to the feature's
 * local service via Telepresence OSS.
 * Additive to the compose path: the container `sandbox up` publishes on the
 * slot host port is the intercept target, so hot-reload keeps working. Only
 * requests carrying `x-feature: <feature>` are rerouted; teammates and
 * baseline dev traffic are untouched.
 *
 * Everything below the argv line lives in `werkmeister-core/telepresence` —
 * `startIntercept`/`leaveIntercept` are callable in-process, so a host server
 * never has to spawn this CLI. What stays here is the
 * five things a remote caller cannot have: argv, the cwd walk-up, the `.env`
 * read, TTY rendering, and the exit code.
 */

import * as tp from "werkmeister-core/telepresence";
import { Colors, error, info, resolveWorkspace, success } from "../lib/config.js";
import { loadDotenv } from "../lib/dotenv.js";
import { interruptSignal } from "../lib/interrupt.js";

function fail(message: string): never {
  error(message);
  process.exit(1);
}

/** The workspace's SERVICES list — a cwd-shaped read core deliberately refuses. */
function localServicesOf(workspace: string): string[] {
  return (loadDotenv(workspace)["SERVICES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Execute ``sandbox intercept``. */
export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.status) {
    for (const cmd of [
      ["telepresence", "status"],
      ["telepresence", "list"],
    ]) {
      const [, out] = tp._run(cmd);
      console.log(out);
    }
    return;
  }

  const dotenv = loadDotenv(process.cwd());
  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    fail("Feature name required: pass it as an argument or set FEATURE in a .env file.");
  }

  const workspace = resolveWorkspace(feature, args.workspace as string | null);
  const localServices = localServicesOf(workspace);
  const service = (args.service as string | null) ?? null;

  // Every SandboxError below reaches main.ts, which prints `[err] <msg>` and
  // exits 1 — the same two lines `fail()` used to run inline.
  if (args.leave) {
    const left = await tp.leaveIntercept({
      feature,
      service,
      localServices,
      dockerDaemon: Boolean(args.docker_daemon),
    });
    if (service) {
      success(`Left intercept for ${service}.`);
    } else if (left.length) {
      success(`Left intercept(s): ${left.join(", ")}`);
    } else {
      info("No active intercepts for this feature.");
    }
    return;
  }

  if (!service) {
    fail("Service required: sandbox intercept <feature> -s <service>");
  }

  const r = await tp.startIntercept({
    feature,
    service,
    localServices,
    dockerDaemon: Boolean(args.docker_daemon),
    signal: interruptSignal(),
  });

  console.log(
    `\n${Colors.GREEN}${Colors.BOLD}=== Intercept active: ${r.service} ===${Colors.RESET}\n`,
  );
  console.log(`  ${Colors.CYAN}Cluster:${Colors.RESET} ${r.context}`);
  console.log(
    `  ${Colors.CYAN}Target:${Colors.RESET}  ${r.namespace}/${r.deployment} → localhost:${r.localPort}`,
  );
  console.log(`  ${Colors.CYAN}Filter:${Colors.RESET}  ${r.header}: ${feature}\n`);
  console.log("  Only cluster requests carrying that header are rerouted to your laptop.");
  if (r.remoteHost) {
    console.log(`  Try:  curl -H '${r.header}: ${feature}' https://${r.remoteHost}/`);
    console.log(
      `  Or:   open https://${r.remoteHost}/ after selecting '${feature}' at /__werkmeister`,
    );
  } else {
    console.log(
      `  Send cluster requests with header '${r.header}: ${feature}' to reach your local ${r.service}.`,
    );
  }
  console.log(`  End:  sandbox intercept ${feature} --leave -s ${r.service}`);
  console.log();
}

// ponytail: no long-running supervision — the intercept lives in the
// telepresence daemon until `--leave`/`sandbox down`; add a `--watch` mode
// only if dangling intercepts become a real problem.
