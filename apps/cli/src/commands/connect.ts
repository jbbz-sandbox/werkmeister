/**
 * sandbox connect
 *
 * Start all shared infrastructure: the k8s port-forwards (redis, postgres),
 * caddy, jaeger, and redisinsight.
 *
 * All services are managed via compose/shared-infra.yml. redis and postgres are
 * not docker services — they run in the OrbStack k8s cluster and are surfaced
 * here by the k8s-forwards container (host 9050 / 9051).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  Colors,
  error,
  getInfraRoot,
  getSandboxRoot,
  info,
  success,
  warn,
} from "../lib/config.js";
import { generateCaddyfile } from "sandbox-core/generate";
import { generateK8sForwards } from "sandbox-core/k8s_forwards";
import { configureGitHooksPath } from "sandbox-core/git_hooks";
import { checkPortForwardHealth, ensurePortForwardsHealthy } from "sandbox-core/k8s";
import { CLAUDECK, DASHBOARD, startAll, status as webStatus } from "sandbox-core/web_servers";
import { ProcError, run as procRun } from "sandbox-core/proc";
import { sandboxHome } from "sandbox-core/global_config";

function isDir(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/**
 * Make a localhost-served API (OrbStack: https://127.0.0.1:26443) reachable
 * from inside the k8s-forwards container. `127.0.0.1`/`localhost` there resolve
 * to the container, not the host, so rewrite the server host to
 * host.docker.internal (mapped to host-gateway in shared-infra.yml). The API
 * cert's SANs won't cover host.docker.internal, so swap CA verification for
 * insecure-skip-tls-verify — acceptable for a local dev tunnel. No-op for a
 * real remote cluster (server host is neither 127.0.0.1 nor localhost).
 */
function shimLocalApiServer(kubeconfig: string): string {
  if (!/server:\s*https:\/\/(127\.0\.0\.1|localhost)\b/.test(kubeconfig)) {
    return kubeconfig;
  }
  return kubeconfig
    .replace(/(server:\s*https:\/\/)(127\.0\.0\.1|localhost)\b/g, "$1host.docker.internal")
    .replace(/^(\s*)certificate-authority-data:.*$/gm, "$1insecure-skip-tls-verify: true");
}

/**
 * Ensure `~/.sandbox/corp-ca.crt` is populated with the corporate TLS-proxy
 * root(s) from the macOS System keychain, if any. Docker build mounts this as
 * a BuildKit secret so `apk`/`curl` inside images validate through Netskope/
 * Zscaler-style intercept. Empty file (no proxy roots found, or non-mac) is a
 * no-op at build time. The file must always EXIST — compose fails hard on a
 * missing `secrets.file` even if no build stage consumes it.
 *
 * ponytail: mac-only extraction via `security`. Linux/WSL devs behind the same
 * proxy can drop their CA at ~/.sandbox/corp-ca.crt manually; this function
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
    const result = procRun(
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

/** Generate proxy/Caddyfile and refresh the k8s kubeconfig. */
async function ensureProxyFiles(): Promise<void> {
  const root = getInfraRoot();

  // Always regenerate: the Caddyfile must carry the host routers (and any
  // active feature's routes) before Caddy loads it.
  const caddyfile = path.join(root, "proxy", "Caddyfile");
  if (isDir(caddyfile)) {
    fs.rmSync(caddyfile, { recursive: true, force: true });
  }
  info("Generating proxy/Caddyfile...");
  await generateCaddyfile();

  // Generate the k8s forward table from services.yaml into the file the
  // k8s-forwards container reads (tmp/forwards) and refresh the ports/aliases
  // regions of shared-infra.yml — must happen before `docker compose up`.
  generateK8sForwards();

  // Always regenerate from the host's current context so the k8s-forwards
  // container tracks `kubectl config use-context` instead of pinning to a
  // stale snapshot. --minify --flatten keeps the file self-contained.
  const kubeconfig = path.join(root, "compose", "k8s-port-forward", "tmp", "kubeconfig");
  if (isDir(kubeconfig)) {
    fs.rmSync(kubeconfig, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(kubeconfig), { recursive: true });
  info("Refreshing k8s-port-forward/tmp/kubeconfig from current context...");
  try {
    const result = procRun(
      ["kubectl", "config", "view", "--raw", "--minify", "--flatten"],
      { capture: true, timeout: 10 },
    );
    if (result.status === 0) {
      fs.writeFileSync(kubeconfig, shimLocalApiServer(result.stdout));
      const ctx = procRun(
        ["kubectl", "--kubeconfig", kubeconfig, "config", "current-context"],
        { capture: true, timeout: 5 },
      );
      const ctxName = ctx.status === 0 ? ctx.stdout.trim() : "?";
      success(`Kubeconfig pinned to context: ${ctxName}`);
    } else {
      error(`kubectl config view failed: ${result.stderr.trim()}`);
    }
  } catch (e) {
    if (e instanceof ProcError && (e.code === "ENOENT" || e.code === "ETIMEDOUT")) {
      error(`Could not generate kubeconfig: ${e.message}`);
    } else {
      throw e;
    }
  }
}

/** Start all infrastructure containers via compose/shared-infra.yml. */
function startSharedInfra(): boolean {
  const root = getSandboxRoot();
  const composeFile = path.join(getInfraRoot(), "compose", "shared-infra.yml");

  if (!fs.existsSync(composeFile)) {
    warn(`Missing ${composeFile}`);
    return false;
  }

  info(
    "Starting shared infrastructure (k8s-forwards, caddy, jaeger, redisinsight)...",
  );
  try {
    // --env-file only if a root .env exists — shared-infra.yml interpolates only
    // ${HOME} (from the process env), so the file is optional. Passing a missing
    // path makes `docker compose` hard-error.
    const envFile = path.join(root, ".env");
    const envArgs = fs.existsSync(envFile) ? ["--env-file", envFile] : [];
    const result = procRun(
      ["docker", "compose", ...envArgs, "-f", composeFile, "up", "-d", "--build"],
      { capture: true },
    );
    if (result.status !== 0) {
      error(`docker compose failed:\n${result.stderr.trim()}`);
      return false;
    }
    success("Shared infrastructure started");
    return true;
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") {
      error("docker not found");
      return false;
    }
    throw e;
  }
}

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

/** Check health of all infrastructure containers. */
async function checkInfraHealth(): Promise<Record<string, boolean>> {
  const composeFile = path.join(getInfraRoot(), "compose", "shared-infra.yml");

  const services: Record<string, boolean> = {};
  try {
    const result = procRun(
      ["docker", "compose", "-f", composeFile, "ps", "--format", "json"],
      { capture: true },
    );
    if (result.status === 0 && result.stdout.trim()) {
      for (const line of result.stdout.trim().split("\n")) {
        try {
          const svc = JSON.parse(line);
          const name = svc["Service"] ?? svc["Name"] ?? "unknown";
          const health = svc["Health"] ?? "";
          const state = svc["State"] ?? "";
          services[name] = health === "healthy" || (state === "running" && health === "");
        } catch {
          continue;
        }
      }
    }
  } catch (e) {
    if (!(e instanceof ProcError && e.code === "ENOENT")) {
      if (!(e instanceof ProcError)) {
        throw e;
      }
    }
  }

  // Fallback: check key ports if docker compose ps didn't work
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

/** Handle `sandbox connect --k8s`: start/restart the k8s port-forwards container only. */
function runK8sOnly(): void {
  console.log(`\n${Colors.BOLD}=== k8s Connect ===${Colors.RESET}\n`);

  const health = checkPortForwardHealth();
  if (health["k8s-forwards"] ?? false) {
    success("k8s port-forwards container is already healthy");
  } else {
    info("Attempting to start/restart k8s-forwards container...");
    const ok = ensurePortForwardsHealthy();
    if (ok) {
      success("k8s port-forwards started");
    } else {
      console.log(`\n  ${Colors.RED}Failed to start k8s port-forwards.${Colors.RESET}`);
      console.log(
        `  ${Colors.DIM}Ensure Docker is running and your kubeconfig is valid.${Colors.RESET}`,
      );
      console.log(`  ${Colors.DIM}Run 'sandbox connect' to start all infrastructure.${Colors.RESET}`);
    }
  }

  console.log();
}

/**
 * Poll checkInfraHealth until every service is healthy or the timeout elapses.
 * `docker compose up -d --build` recreates containers whose image rebuilt
 * (k8s-forwards rebuilds each run), so a single immediate snapshot catches them
 * mid-`start_period` and misreports them as down. Polling lets the summary
 * reflect the converged state instead.
 */
async function waitForInfraHealth(timeoutSec: number): Promise<Record<string, boolean>> {
  const deadline = Date.now() + timeoutSec * 1000;
  let health = await checkInfraHealth();
  while (Object.keys(health).length > 0 && Object.values(health).some((h) => !h) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    health = await checkInfraHealth();
  }
  return health;
}

/** Execute the `sandbox connect` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.k8s) {
    runK8sOnly();
    return;
  }

  console.log(`\n${Colors.BOLD}=== Sandbox Connect ===${Colors.RESET}\n`);

  // Auto-configure the secret-commit guard hook (idempotent, never clobbers
  // a pre-existing custom core.hooksPath). Informational only — a
  // hooksPath conflict should warn, not block `sandbox connect`.
  configureGitHooksPath();

  // Ensure proxy files exist before docker compose tries to read them
  await ensureProxyFiles();

  // Extract corporate TLS-proxy root(s) so the k8s-forwards image build can
  // validate outbound HTTPS. Must run before `docker compose up` — the
  // compose file declares `secrets.corp_ca.file: ~/.sandbox/corp-ca.crt` and
  // will hard-fail if the path doesn't exist.
  ensureCorpCa();

  // Start all infrastructure (including k8s port-forwards)
  const infraOk = startSharedInfra();

  // Build + start the host web servers (the workspaces dashboard and Claudeck
  // — node processes, not containers, since their tools drive host-local
  // Docker/VS Code/kubectl/claude). Rebuilds only when a source is newer than
  // the last build, and bounces a running server only when it actually
  // rebuilt — a no-change re-run leaves them untouched.
  await startAll(true);

  // Health summary
  console.log(`\n${Colors.BOLD}--- Health Summary ---${Colors.RESET}\n`);

  // k8s-forwards' start_period is 60s; give recreated containers time to
  // converge before reporting so the summary isn't a premature snapshot.
  info("Waiting for services to become healthy...");
  const health = await waitForInfraHealth(90);
  for (const [name, healthy] of Object.entries(health).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const status = healthy
      ? `${Colors.GREEN}healthy${Colors.RESET}`
      : `${Colors.RED}down${Colors.RESET}`;
    console.log(`  ${name.padEnd(30)} ${status}`);
  }

  const totalHealthy = Object.values(health).filter((v) => v).length;
  const total = Object.keys(health).length;

  console.log();
  if (totalHealthy === total) {
    console.log(`  ${Colors.GREEN}${Colors.BOLD}All ${total} services healthy${Colors.RESET}`);
  } else {
    const down = total - totalHealthy;
    console.log(`  ${Colors.YELLOW}${totalHealthy}/${total} healthy, ${down} down${Colors.RESET}`);
    if (!infraOk) {
      console.log(`  ${Colors.DIM}Check docker and your kubeconfig.${Colors.RESET}`);
    }
  }

  console.log();
  console.log(`  ${Colors.BOLD}Developer tools:${Colors.RESET}`);
  console.log(`    ${Colors.CYAN}RedisInsight:${Colors.RESET}  https://tools.local.sandbox.com/redisinsight`);
  console.log(`    ${Colors.CYAN}Jaeger:${Colors.RESET}        https://tools.local.sandbox.com/jaeger`);
  console.log(`    ${Colors.CYAN}GraphQL:${Colors.RESET}       https://tools.local.sandbox.com/graphql`);
  const mcp = await webStatus(DASHBOARD);
  console.log(`    ${Colors.CYAN}Sandbox MCP:${Colors.RESET}   ${mcp.url}  (workspaces dashboard; MCP at /mcp)`);
  const claudeck = await webStatus(CLAUDECK);
  console.log(`    ${Colors.CYAN}Claudeck:${Colors.RESET}      ${claudeck.url}`);
  console.log();
}
