/**
 * Shared infrastructure management (compose/shared-infra.yml).
 *
 * All four verbs of the `infra` target live here: `up` is what `werkmeister infra connect`
 * and `werkmeister infra up` both run, and `down`/`stop`/`restart` are what the
 * matching commands route to when their target is "infra".
 *
 * Per §4, nothing here decides layout: progress goes through the reporter, and
 * the banners, the health table and the developer-tools block are the CLI's,
 * in `commands/connect.ts`. `down`/`stop`/`restart` printed their own banners
 * until row 5g — they arrived by a step-3 file move that predated the rule, not
 * by a second convention.
 *
 * `up()` existed once before, as a dynamic import of `commands/connect.js`
 * behind a hoisted string constant; 353984e deleted it as an inversion and
 * deferred the real seam to step 5 (note 038). This is that seam — the body is
 * here now, and nothing in this file reaches into `apps/cli`.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { baselineSpecs, generateBaselineOverride } from "./baseline.js";
import { CADDY_CONTAINER } from "./caddy.js";
import { stopOrRestart, takeDownProject } from "./compose.js";
import {
  composeInvocation,
  INFRA_PROJECT,
  infraProfiles,
  LEGACY_INFRA_PROJECT,
  recreatePlan,
  staleInfraContainers,
} from "./compose_infra.js";
import { hostSessionSkipReason, sandboxHome } from "./config.js";
import { execCapture, projectContainers } from "./docker.js";
import { generateCaddyfile } from "./generate.js";
import { configureGitHooksPath } from "./git_hooks.js";
import { checkPortForwardHealth, ensurePortForwardsHealthy, refreshKubeconfig } from "./k8s.js";
import { generateK8sForwards } from "./k8s_forwards.js";
import { ProcError, run, runAsync } from "./proc.js";
import { error, info, success, warn } from "./reporter.js";
import { restartAll, startAll, stopAll } from "./web_servers.js";

function composeCmd(subcommand: string[]): boolean {
  const { argv, env, cwd } = composeInvocation();
  const cmd = [...argv, ...subcommand];
  info(`Running: ${cmd.join(" ")}`);
  try {
    const result = run(cmd, { capture: true, timeout: 120, env, cwd });
    if (result.status !== 0) {
      error(`docker compose failed:\n${result.stderr.trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof ProcError && err.code === "ENOENT") {
      error("docker not found");
      return false;
    }
    if (err instanceof ProcError && err.code === "ETIMEDOUT") {
      error("docker compose timed out");
      return false;
    }
    throw err;
  }
}

/**
 * Ensure `~/.werkmeister/corp-ca.crt` is populated with the corporate TLS-proxy
 * root(s) from the macOS System keychain, if any. Docker build mounts this as
 * a BuildKit secret so `apk`/`curl` inside images validate through Netskope/
 * Zscaler-style intercept. Empty file (no proxy roots found, or non-mac) is a
 * no-op at build time. The file must always EXIST — compose fails hard on a
 * missing `secrets.file` even if no build stage consumes it.
 *
 * ponytail: mac-only extraction via `security`. Linux/WSL devs behind the same
 * proxy can drop their CA at ~/.werkmeister/corp-ca.crt manually; this function
 * won't overwrite a pre-populated file (only touches empty/missing).
 */
function ensureCorpCa(): void {
  const dest = path.join(sandboxHome(), "corp-ca.crt");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  if (existing.includes("BEGIN CERTIFICATE")) {
    return;
  }
  if (os.platform() !== "darwin") {
    fs.writeFileSync(dest, "");
    return;
  }
  // `security find-certificate -c` filters by CN substring. Common corporate
  // TLS-intercept vendors and the CN pattern they use:
  //   Netskope    → goskope.com intermediate + certadmin root
  //   Zscaler     → Zscaler Root CA
  //   Palo Alto   → Palo Alto Networks
  // The intermediate alone is NOT enough — openssl walks up to the root and
  // rejects the chain if the root isn't trusted. Netskope's chain terminates
  // at CN=certadmin (O=Netskope Inc.), so we grab both. Empty output on all
  // matches → off-proxy machine; write an empty file so compose's secret path
  // still resolves.
  const filters = ["goskope", "certadmin", "Zscaler", "Palo Alto"];
  const pems: string[] = [];
  for (const filter of filters) {
    const result = run(
      [
        "security",
        "find-certificate",
        "-a",
        "-p",
        "-c",
        filter,
        "/Library/Keychains/System.keychain",
      ],
      { capture: true, timeout: 5 },
    );
    if (result.status === 0 && result.stdout.includes("BEGIN CERTIFICATE")) {
      pems.push(result.stdout);
    }
  }
  const pem = pems.join("");
  fs.writeFileSync(dest, pem);
  if (pem.includes("BEGIN CERTIFICATE")) {
    info(`Corporate CA extracted to ${dest} (image builds will trust it)`);
  }
}

/** Generate proxy/Caddyfile and refresh the k8s kubeconfig, under ~/.werkmeister/infra. */
async function ensureProxyFiles(): Promise<void> {
  // Always regenerate: the Caddyfile must carry the host routers (and any
  // active feature's routes) before Caddy loads it. generateCaddyfile() also
  // clears a directory Docker may have left at the path.
  info("Generating proxy/Caddyfile...");
  await generateCaddyfile();

  // Generate the k8s forward table from services.yaml into the file the
  // k8s-forwards container reads (k8s-port-forward/forwards) and the compose
  // override — must happen before `docker compose up`.
  generateK8sForwards();
  // Throws on a bad infra.baseline entry, before compose ever sees it.
  generateBaselineOverride();

  refreshKubeconfig();
}

/** The shared containers are the machine's, reached through the real DOCKER_CONFIG: a fixture or temp HOME leaves them be (SW-1054). */
function sharedInfraSkipped(what: string): boolean {
  const skip = hostSessionSkipReason();
  if (skip) info(`Shared infra (Caddy, k8s forwards) ${what} skipped (${skip})`);
  return skip !== undefined;
}

/**
 * Start all infrastructure containers via compose/shared-infra.yml.
 *
 * Not `composeCmd(["up", "-d", "--build"])`: that one announces the command it
 * runs and caps it at 120s, and this path both stays quiet and rebuilds the
 * k8s-forwards image, which routinely outlasts the cap.
 */
export async function startSharedInfra(signal?: AbortSignal): Promise<boolean> {
  if (sharedInfraSkipped("start")) return true;
  const { argv, env, cwd } = composeInvocation();
  const composeFile = argv[3];

  if (!fs.existsSync(composeFile)) {
    warn(`Missing ${composeFile}`);
    return false;
  }

  takeDownProject(LEGACY_INFRA_PROJECT, "the pre-rename shared infra");
  const started = [
    "k8s-forwards",
    "caddy",
    ...infraProfiles(),
    ...baselineSpecs().map((s) => `baseline-${s.service}`),
  ];
  info(`Starting shared infrastructure (${started.join(", ")})...`);
  try {
    const result = await runAsync([...argv, "up", "-d", "--build"], {
      capture: true,
      signal,
      env,
      cwd,
    });
    if (result.status !== 0) {
      error(`docker compose failed:\n${result.stderr.trim()}`);
      return false;
    }
    // `up` recreates a container whose resolved binds changed, not one whose only drift is
    // the compose files it was made from (w9r-k8s-forwards after a checkout move, SW-610).
    const { recreate, leftover } = recreatePlan(await staleInfraContainers(), started);
    for (const s of leftover) {
      warn(
        `${s.name} was ${s.reason}, and this checkout has no such service: remove it with \`docker rm -f ${s.name}\``,
      );
    }
    if (recreate.length) {
      info(`Recreating ${recreate.join(", ")} from this checkout...`);
      const again = await runAsync(
        [...argv, "up", "-d", "--no-deps", "--force-recreate", ...recreate],
        { capture: true, signal, env, cwd },
      );
      if (again.status !== 0) {
        error(`docker compose failed:\n${again.stderr.trim()}`);
        return false;
      }
    }
    success("Shared infrastructure started");
    return true;
  } catch (e) {
    if (e instanceof ProcError && e.code === "ABORT_ERR") {
      warn("Shared infrastructure start was cancelled");
      return false;
    }
    if (e instanceof ProcError && e.code === "ENOENT") {
      error("docker not found");
      return false;
    }
    throw e;
  }
}

/** The page Caddy serves for `/__werkmeister` (generate.ts's `root * /werkmeister/proxy/ui`). */
const PICKER_PAGE = "/werkmeister/proxy/ui/index.html";

function checkPort(host: string, port: number, timeoutSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutSec * 1000);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

/**
 * Check health of all infrastructure containers.
 *
 * Distinct from `status.ts`'s `getInfraStatus`, which reads the same containers
 * but reports a four-way display string and has no fallback. This one is a
 * healthy/not-healthy verdict that must still answer when the daemon cannot, so
 * `werkmeister infra connect` can say what converged.
 */
async function checkInfraHealth(): Promise<Record<string, boolean>> {
  const services: Record<string, boolean> = {};
  for (const c of (await projectContainers(INFRA_PROJECT, undefined, { all: false })) ?? []) {
    services[c.service || c.name] = c.health === "healthy" || (c.state === "running" && !c.health);
  }
  // Running is not serving: an empty picker mount 404s /__werkmeister on every host (SW-610).
  if (services["caddy"]) {
    const picker = await execCapture(CADDY_CONTAINER, ["test", "-s", PICKER_PAGE]).catch(
      () => null,
    );
    services["caddy"] = picker?.exitCode === 0;
  }

  // Fallback: check key ports if the daemon listed nothing
  if (!Object.keys(services).length) {
    const portChecks: [string, number][] = [
      ["redis", 9050],
      ["postgres", 9051],
      ["caddy", 443],
    ];
    for (const [name, port] of portChecks) {
      services[name] = await checkPort("127.0.0.1", port, 2.0);
    }
  }

  return services;
}

// Health is deliberately a second call (`infraHealth`), because the CLI prints
// its section header between the two and a library that owned both would have
// to print that header itself. The CLI turns a false return into the "check
// docker and your kubeconfig" hint.
/**
 * Brings up werkmeister's shared infrastructure stack (the proxy, generated
 * config, the corporate CA and the host web servers). It is the machine-wide
 * stack every workspace routes through, not a workspace: to start a workspace's
 * containers, use `runWorkspaceAction` with `"up"`.
 *
 * Runs in-process. It writes the proxy files under `~/.werkmeister`, extracts
 * the corporate CA, runs `docker compose up -d --build` for the shared stack
 * (the Caddy proxy and the k8s port-forwards, plus any baseline services), then
 * builds and starts the host web servers (the workspaces dashboard and the MCP
 * server). Safe to re-run: the web servers restart only when they rebuilt.
 *
 * @param signal - Cancels the compose step. Already aborted: nothing is touched
 *   and it returns false. Aborted during `docker compose up`: compose stops and it
 *   returns false, but the host web servers are still built and started.
 * @returns True when the compose stack started; false when it was cancelled,
 *   the shared compose file is missing, docker is missing or `docker compose`
 *   failed. It does not wait for the services to become healthy.
 * @throws Error when the compose process fails to spawn for any other reason.
 *
 * @example
 * ```ts
 * import { infraUp } from "werkmeister-core/sdk";
 *
 * const started = await infraUp({ signal: AbortSignal.timeout(300_000) });
 * if (!started) {
 *   console.error("Shared infrastructure did not start: check docker.");
 * }
 * ```
 */
export async function up({ signal }: { signal?: AbortSignal } = {}): Promise<boolean> {
  // Ahead of everything, not just of the compose spawn: the setup below writes
  // proxy files, extracts a CA and configures a git hooks path. A caller that
  // has already cancelled should get none of it.
  if (signal?.aborted) {
    warn("Infrastructure start was cancelled before it began");
    return false;
  }

  // Auto-configure the secret-commit guard hook (idempotent, never clobbers
  // a pre-existing custom core.hooksPath). Informational only — a
  // hooksPath conflict should warn, not block `werkmeister infra connect`.
  configureGitHooksPath();

  // Ensure proxy files exist before docker compose tries to read them
  await ensureProxyFiles();

  // Extract corporate TLS-proxy root(s) so the k8s-forwards image build can
  // validate outbound HTTPS. Must run before `docker compose up` — the
  // compose file declares `secrets.corp_ca.file: ~/.werkmeister/corp-ca.crt` and
  // will hard-fail if the path doesn't exist.
  ensureCorpCa();

  const infraOk = await startSharedInfra(signal);

  // Build + start the host web servers (the workspaces dashboard and the MCP
  // surface — node processes, not containers, since their tools drive host-local
  // Docker/VS Code/kubectl/claude). Rebuilds only when a source is newer than
  // the last build, and bounces a running server only when it actually
  // rebuilt — a no-change re-run leaves them untouched.
  await startAll(true);

  return infraOk;
}

// Polls rather than snapshotting once: `docker compose up -d --build` recreates
// containers whose image rebuilt (k8s-forwards rebuilds each run), so an
// immediate snapshot catches them mid-`start_period` and misreports them as down.
/**
 * Waits for the shared infrastructure containers to become healthy and
 * reports each one. Call it after `infraUp`, which does not wait. Runs
 * in-process and talks to Docker directly, checking every 3 seconds.
 *
 * @param timeoutSec - How long to keep checking, in seconds. It stops
 *   earlier once every service is healthy.
 * @returns Each shared service's name mapped to whether it is healthy (or
 *   running, for a container without a health check). When Docker lists no
 *   shared containers, it probes the `redis`, `postgres` and `caddy` ports
 *   on localhost instead and reports those.
 *
 * @example
 * ```ts
 * import { infraHealth, infraUp } from "werkmeister-core/sdk";
 *
 * if (await infraUp()) {
 *   const health = await infraHealth(60);
 *   const down = Object.keys(health).filter((name) => !health[name]);
 *   if (down.length) console.error(`Not healthy: ${down.join(", ")}`);
 * }
 * ```
 */
export async function infraHealth(timeoutSec: number): Promise<Record<string, boolean>> {
  info("Waiting for services to become healthy...");
  const deadline = Date.now() + timeoutSec * 1000;
  let health = await checkInfraHealth();
  while (
    Object.keys(health).length > 0 &&
    Object.values(health).some((h) => !h) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    health = await checkInfraHealth();
  }
  return health;
}

// What `werkmeister infra connect --k8s` runs. The CLI turns a false return
// into its recovery hint.
/**
 * Starts the Kubernetes port-forwards container on its own, without the rest
 * of the shared infrastructure. Does nothing when it is already healthy;
 * otherwise refreshes the kubeconfig and restarts it. Runs in-process and talks
 * to Docker directly.
 *
 * @returns True when the port-forwards are healthy; false when there is no
 *   kubeconfig, no reachable cluster, or the container did not come up.
 *
 * @example
 * ```ts
 * import { connectK8s } from "werkmeister-core/sdk";
 *
 * if (!(await connectK8s())) {
 *   console.error("k8s port-forwards are down: check your kubeconfig and cluster.");
 * }
 * ```
 */
export async function connectK8s(): Promise<boolean> {
  if ((await checkPortForwardHealth())["k8s-forwards"] ?? false) {
    success("k8s port-forwards container is already healthy");
    return true;
  }
  info("Attempting to start/restart k8s-forwards container...");
  const ok = (await ensurePortForwardsHealthy()) !== "failed";
  if (ok) {
    success("k8s port-forwards started");
  }
  return ok;
}

/**
 * Stops the host web servers, then stops and removes the shared
 * infrastructure containers (exported from the SDK as `infraDown`). Workspace
 * containers are not touched. Runs in-process with `docker compose down`.
 *
 * @param volumes - Also remove the shared stack's volumes. Defaults to false.
 * @returns True when `docker compose down` succeeded; false when it failed or timed
 *   out, which is also logged.
 * @throws Error when the compose process fails to spawn for a reason other
 *   than docker being missing or timing out.
 *
 * @example
 * ```ts
 * import { infraDown } from "werkmeister-core/sdk";
 *
 * // Tear down the proxy and port-forwards, keeping their volumes.
 * if (!(await infraDown())) console.error("shared infra is still up");
 * ```
 */
export async function down(volumes = false): Promise<boolean> {
  await stopAll();
  if (sharedInfraSkipped("down")) return true;
  takeDownProject(LEGACY_INFRA_PROJECT, "the pre-rename shared infra", { removeVolumes: volumes });
  // `--profile *`: plain `down` skips an opted-in jaeger/redisinsight (as
  // compose.ts's ALL_PROFILES does for workspaces).
  const args = ["--profile", "*", "down"];
  if (volumes) {
    args.push("--volumes");
  }
  const ok = composeCmd(args);
  if (ok) {
    let msg = "Shared infrastructure stopped";
    if (volumes) {
      msg += " (volumes removed)";
    }
    success(msg);
  }
  return ok;
}

/**
 * Stops the host web servers and the shared infrastructure containers, but
 * keeps the containers so `infraUp` or `infraRestart` can bring them back
 * (exported from the SDK as `infraStop`). Runs in-process and talks to Docker
 * directly.
 *
 * @returns True when the containers stopped; false on a Docker failure, which is
 *   also logged.
 *
 * @example
 * ```ts
 * import { infraStop } from "werkmeister-core/sdk";
 *
 * if (!(await infraStop())) console.error("shared infra did not stop");
 * ```
 */
export async function stop(): Promise<boolean> {
  await stopAll();
  if (sharedInfraSkipped("stop")) return true;
  const err = await stopOrRestart("stop", INFRA_PROJECT);
  if (err) {
    error(err);
    return false;
  }
  success(
    "Shared infrastructure stopped (containers preserved, resumable with 'werkmeister infra up')",
  );
  return true;
}

/**
 * Restarts the shared infrastructure containers, including stopped ones, then
 * restarts the host web servers (exported from the SDK as `infraRestart`). Runs
 * in-process and talks to Docker directly.
 *
 * @returns True when the containers restarted; false on a Docker failure, which is
 *   also logged. The web servers are restarted either way.
 *
 * @example
 * ```ts
 * import { infraHealth, infraRestart } from "werkmeister-core/sdk";
 *
 * if (await infraRestart()) console.log(await infraHealth(30));
 * ```
 */
export async function restart(): Promise<boolean> {
  if (sharedInfraSkipped("restart")) {
    await restartAll();
    return true;
  }
  const err = await stopOrRestart("restart", INFRA_PROJECT);
  if (err) error(err);
  else success("Shared infrastructure restarted");
  await restartAll();
  return !err;
}
