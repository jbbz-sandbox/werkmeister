/**
 * sandbox intercept <feature> -s <service>
 *
 * Route a header-scoped slice of live k8s **dev** traffic to the feature's
 * local service via Telepresence OSS.
 * Additive to the compose path: the container `sandbox up` publishes on the
 * slot host port is the intercept target, so hot-reload keeps working. Only
 * requests carrying `x-feature: <feature>` are rerouted; teammates and
 * baseline dev traffic are untouched.
 */

import * as net from "node:net";

import {
  Colors,
  error,
  getK8sContext,
  info,
  loadServices,
  resolveWorkspace,
  success,
} from "../lib/config.js";
import { loadFeatureRouters } from "sandbox-core/feature_routing";
import { getServicePort, getSlot } from "sandbox-core/slots";
import * as tp from "../lib/telepresence.js";
import { loadDotenv } from "../lib/dotenv.js";

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "localhost");
  });
}

function fail(message: string): never {
  error(message);
  process.exit(1);
}

/**
 * Validate *service* is a local service of this workspace with full k8s
 * coordinates; return its services.yaml definition.
 */
function resolveServiceDef(service: string, workspace: string): Record<string, any> {
  const workspaceEnv = loadDotenv(workspace);
  const local = (workspaceEnv["SERVICES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!local.includes(service)) {
    fail(
      `'${service}' is not a local service of this workspace ` +
        `(SERVICES=${local.join(",") || "(none)"}). Add it to ` +
        "workspace.yml services and rerun `sandbox init-workspace`.",
    );
  }
  // Interceptability is defined once, in telepresence.ts, so `sandbox status
  // --intercepts` reports exactly what this command enforces.
  const svcDef = loadServices()[service];
  const blocker = tp.interceptBlocker(svcDef);
  if (blocker) {
    fail(`'${service}' ${blocker}`);
  }
  return svcDef;
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
  const service = (args.service as string | null) ?? null;

  if (args.leave) {
    if (service) {
      const svcDef = resolveServiceDef(service, workspace);
      const [rc, out] = tp._run(tp.buildLeaveArgs(svcDef["k8s_deployment"]));
      if (rc === 0) {
        success(`Left intercept for ${service}.`);
      } else {
        fail(`Could not leave intercept: ${out || "no output"}`);
      }
    } else {
      const left = tp.leaveFeatureIntercepts(feature);
      if (left.length) {
        success(`Left intercept(s): ${left.join(", ")}`);
      } else {
        info("No active intercepts for this feature.");
      }
    }
    return;
  }

  if (!service) {
    fail("Service required: sandbox intercept <feature> -s <service>");
  }

  const problem = tp.versionError();
  if (problem) {
    fail(problem);
  }

  const svcDef = resolveServiceDef(service, workspace);

  const slot = await getSlot(feature);
  if (slot === null) {
    fail(`Feature '${feature}' has no allocated slot — run \`sandbox up ${feature}\` first.`);
  }
  const localPort = getServicePort(slot, svcDef["port_offset"] ?? 0);
  if (!(await portOpen(localPort))) {
    fail(
      `${service} is not listening on localhost:${localPort} — ` +
        `run \`sandbox up ${feature}\` first (the local container is the intercept target).`,
    );
  }

  const context = getK8sContext();
  const namespace = svcDef["k8s_namespace"];
  const deployment = svcDef["k8s_deployment"];

  info(`Connecting to ${namespace} on ${context}...`);
  tp.ensureConnected(context, namespace, Boolean(args.docker_daemon));

  info(`Intercepting ${deployment} → localhost:${localPort} (x-feature=${feature})...`);
  const [rc, out] = tp._run(
    tp.buildInterceptArgs(deployment, localPort, svcDef["k8s_port"], feature),
  );
  if (rc !== 0) {
    fail(`telepresence intercept failed: ${out || "no output"}`);
  }

  // The service's remote (cluster) hostname is where Caddy sends cluster-bound
  // traffic; a request there carrying the header (or the X-Feature cookie, which
  // Caddy copies into the header) is what the intercept reroutes to your laptop.
  const remoteHost = loadFeatureRouters()[service]?.remoteHostname ?? null;

  console.log(`\n${Colors.GREEN}${Colors.BOLD}=== Intercept active: ${service} ===${Colors.RESET}\n`);
  console.log(`  ${Colors.CYAN}Cluster:${Colors.RESET} ${context}`);
  console.log(`  ${Colors.CYAN}Target:${Colors.RESET}  ${namespace}/${deployment} → localhost:${localPort}`);
  console.log(`  ${Colors.CYAN}Filter:${Colors.RESET}  x-feature: ${feature}\n`);
  console.log("  Only cluster requests carrying that header are rerouted to your laptop.");
  if (remoteHost) {
    console.log(`  Try:  curl -H 'x-feature: ${feature}' https://${remoteHost}/`);
    console.log(`  Or:   open https://${remoteHost}/ after selecting '${feature}' at /__sandbox`);
  } else {
    console.log(`  Send cluster requests with header 'x-feature: ${feature}' to reach your local ${service}.`);
  }
  console.log(`  End:  sandbox intercept ${feature} --leave -s ${service}`);
  console.log();
}

// ponytail: no long-running supervision — the intercept lives in the
// telepresence daemon until `--leave`/`sandbox down`; add a `--watch` mode
// only if dangling intercepts become a real problem.
