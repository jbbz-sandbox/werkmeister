/**
 * Shared infrastructure management (compose/shared-infra.yml).
 *
 * All four verbs of the `infra` target live here: `up` is what `sandbox connect`
 * and `sandbox up infra` both run, and `down`/`stop`/`restart` are what the
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

import { infraRoot, sandboxHome, sandboxRoot } from "./config.js";
import { generateCaddyfile } from "./generate.js";
import { configureGitHooksPath } from "./git_hooks.js";
import { checkPortForwardHealth, ensurePortForwardsHealthy } from "./k8s.js";
import { generateK8sForwards } from "./k8s_forwards.js";
import { ProcError, run } from "./proc.js";
import { error, info, success, warn } from "./reporter.js";
import { restartAll, startAll, stopAll } from "./web_servers.js";

function composeCmd(subcommand: string[]): boolean {
  const root = sandboxRoot();
  const composeFile = path.join(infraRoot(), "compose", "shared-infra.yml");
  // --env-file only if a root .env exists — shared-infra.yml interpolates only
  // ${HOME} (from the process env), so the file is optional. Passing a missing
  // path makes `docker compose` hard-error. `startSharedInfra` has guarded this
  // since it was written; this side never did, so every teardown hard-errored
  // on a machine with no apps/cli/.env — which is all of them, since nothing
  // creates that file.
  const envFile = path.join(root, ".env");
  const envArgs = fs.existsSync(envFile) ? ["--env-file", envFile] : [];
  const cmd = ["docker", "compose", ...envArgs, "-f", composeFile, ...subcommand];
  info(`Running: ${cmd.join(" ")}`);
  try {
    const result = run(cmd, { capture: true, timeout: 120 });
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

// ponytail: these all write into the CLI's own directory, which for an
// `npm i -g` install is inside node_modules. Harmless on an nvm or Homebrew
// prefix (user-owned, and every file here is regenerated on each connect, so
// `npm update -g` discarding them costs nothing) but it would fail EACCES on a
// root-owned prefix. Move the generated set to ~/.sandbox/infra/ if anyone hits
// that.
/** Generate proxy/Caddyfile and refresh the k8s kubeconfig. */
async function ensureProxyFiles(): Promise<void> {
  const root = infraRoot();

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
    const result = run(
      ["kubectl", "config", "view", "--raw", "--minify", "--flatten"],
      { capture: true, timeout: 10 },
    );
    if (result.status === 0) {
      fs.writeFileSync(kubeconfig, shimLocalApiServer(result.stdout));
      const ctx = run(
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

/**
 * Start all infrastructure containers via compose/shared-infra.yml.
 *
 * Not `composeCmd(["up", "-d", "--build"])`: that one announces the command it
 * runs and caps it at 120s, and this path both stays quiet and rebuilds the
 * k8s-forwards image, which routinely outlasts the cap.
 */
function startSharedInfra(): boolean {
  const root = sandboxRoot();
  const composeFile = path.join(infraRoot(), "compose", "shared-infra.yml");

  if (!fs.existsSync(composeFile)) {
    warn(`Missing ${composeFile}`);
    return false;
  }

  info(
    "Starting shared infrastructure (k8s-forwards, caddy, jaeger, redisinsight)...",
  );
  try {
    const envFile = path.join(root, ".env");
    const envArgs = fs.existsSync(envFile) ? ["--env-file", envFile] : [];
    const result = run(
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

/**
 * Check health of all infrastructure containers.
 *
 * Distinct from `status.ts`'s `getInfraStatus`, which reads the same `compose
 * ps` but reports a four-way display string and has no fallback. This one is a
 * healthy/not-healthy verdict that must still answer when compose cannot, so
 * `sandbox connect` can say what converged.
 */
async function checkInfraHealth(): Promise<Record<string, boolean>> {
  const composeFile = path.join(infraRoot(), "compose", "shared-infra.yml");

  const services: Record<string, boolean> = {};
  try {
    const result = run(
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

/**
 * Bring shared infrastructure up: generated files, the corporate CA, the
 * compose stack, and the host web servers.
 *
 * Returns whether the compose stack itself started — the caller reports it as
 * the "check docker and your kubeconfig" hint. Health is deliberately a second
 * call (`infraHealth`), because the CLI prints its section header between the
 * two and a library that owned both would have to print that header itself.
 */
export async function up(): Promise<boolean> {
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

  const infraOk = startSharedInfra();

  // Build + start the host web servers (the workspaces dashboard and Claudeck
  // — node processes, not containers, since their tools drive host-local
  // Docker/VS Code/kubectl/claude). Rebuilds only when a source is newer than
  // the last build, and bounces a running server only when it actually
  // rebuilt — a no-change re-run leaves them untouched.
  await startAll(true);

  return infraOk;
}

/**
 * Poll until every infrastructure service is healthy or *timeoutSec* elapses.
 *
 * `docker compose up -d --build` recreates containers whose image rebuilt
 * (k8s-forwards rebuilds each run), so a single immediate snapshot catches them
 * mid-`start_period` and misreports them as down. Polling lets the summary
 * reflect the converged state instead.
 */
export async function infraHealth(timeoutSec: number): Promise<Record<string, boolean>> {
  info("Waiting for services to become healthy...");
  const deadline = Date.now() + timeoutSec * 1000;
  let health = await checkInfraHealth();
  while (Object.keys(health).length > 0 && Object.values(health).some((h) => !h) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    health = await checkInfraHealth();
  }
  return health;
}

/**
 * Start or restart the k8s port-forwards container only (`sandbox connect --k8s`).
 *
 * Returns whether the forwards are up; the caller turns a false into the
 * recovery hint, which is a next-step and so stays CLI-side.
 */
export function connectK8s(): boolean {
  if (checkPortForwardHealth()["k8s-forwards"] ?? false) {
    success("k8s port-forwards container is already healthy");
    return true;
  }
  info("Attempting to start/restart k8s-forwards container...");
  const ok = ensurePortForwardsHealthy() !== "failed";
  if (ok) {
    success("k8s port-forwards started");
  }
  return ok;
}

/** Stop and remove shared infrastructure containers. */
export async function down(volumes = false): Promise<void> {
  await stopAll();
  const args = ["down"];
  if (volumes) {
    args.push("--volumes");
  }
  if (composeCmd(args)) {
    let msg = "Shared infrastructure stopped";
    if (volumes) {
      msg += " (volumes removed)";
    }
    success(msg);
  }
}

/** Stop shared infrastructure containers without removing them. */
export async function stop(): Promise<void> {
  await stopAll();
  if (composeCmd(["stop"])) {
    success("Shared infrastructure stopped (containers preserved, resumable with 'sandbox up infra')");
  }
}

/** Restart shared infrastructure containers. */
export async function restart(): Promise<void> {
  if (composeCmd(["restart"])) {
    success("Shared infrastructure restarted");
  }
  await restartAll();
}
