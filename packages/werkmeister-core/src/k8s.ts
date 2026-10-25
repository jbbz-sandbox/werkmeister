/**
 * k8s port-forward management for the developer sandbox.
 *
 * Port-forwards run inside a Docker container (k8s-forwards) as part of the
 * shared infrastructure (compose/shared-infra.yml). This module provides
 * health-check and status utilities for that container.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Colors } from "./colors.js";
import { composeInvocation, INFRA_PROJECT } from "./compose_infra.js";
import { loadServices, needsCluster, type ServicesConfig, stateInfraRoot } from "./config.js";
import { containerRunning, type ProjectContainer, projectContainers } from "./docker.js";
import { SandboxError } from "./errors.js";
import { type ForwardSpec, forwardSpecs } from "./k8s_forwards.js";
import { ProcError, run } from "./proc.js";
import { error, info, success, warn } from "./reporter.js";
import { LABEL_FEATURE } from "./slots.js";

// The forward table is NOT duplicated here: `forwardSpecs()` derives it from
// ~/.werkmeister/services.yaml — the same call that generates the entrypoint's
// data file and shared-infra.yml's ports/aliases, so health checks can never
// probe a service the container isn't actually forwarding.

/**
 * Check the health of the containerized k8s-forwards service: healthy, or
 * running with no healthcheck declared.
 */
export async function checkPortForwardHealth(): Promise<Record<string, boolean>> {
  const live = (await projectContainers(INFRA_PROJECT, "k8s-forwards", { all: false })) ?? [];
  return {
    "k8s-forwards": live.some(
      (c) => c.health === "healthy" || (c.state === "running" && !c.health),
    ),
  };
}

/**
 * Whether a running feature has a local service that needs the k8s-forwards
 * container (SW-42). `sandbox up` starts the forwarder only then, so a stopped
 * one is otherwise the normal state, not a fault. A feature's local services
 * are all its containers, running or not; it counts once any of them runs.
 * `null` containers (docker unreachable) count as needed, so an outage still warns.
 */
export function clusterNeeded(
  containers: ProjectContainer[] | null,
  services: ServicesConfig,
): boolean {
  if (!containers) return true;
  const features = new Map<string, { local: string[]; running: boolean }>();
  for (const c of containers) {
    const feature = c.labels[LABEL_FEATURE];
    if (!feature) continue;
    const f = features.get(feature) ?? { local: [], running: false };
    f.local.push(c.service);
    f.running ||= c.state === "running";
    features.set(feature, f);
  }
  return [...features.values()].some((f) => f.running && needsCluster(f.local, services));
}

/**
 * {@link clusterNeeded} against the registry, listing containers unless given
 * them. An unreadable registry counts as needed.
 */
export async function forwarderNeeded(containers?: ProjectContainer[] | null): Promise<boolean> {
  let services: ServicesConfig;
  try {
    services = loadServices();
  } catch {
    return true;
  }
  return clusterNeeded(containers === undefined ? await projectContainers() : containers, services);
}

/**
 * What `ensurePortForwardsHealthy` did.
 *
 * `restarted` is distinct from `healthy` because a restart returns as soon as
 * the *container* runs, which is not when its tunnels carry traffic — the
 * caller has to wait, and only then. See {@link waitForForwards}.
 */
export type ForwardsOutcome = "healthy" | "restarted" | "failed";

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
 * Rewrite the kubeconfig the k8s-forwards container bind-mounts. Returns false
 * if no regular file is left: compose would then bind-mount a Docker-created
 * directory in its place (#97).
 */
export function refreshKubeconfig(): boolean {
  // Regenerate from the host's current context so the k8s-forwards
  // container tracks `kubectl config use-context` instead of pinning to a
  // stale snapshot. --minify --flatten keeps the file self-contained.
  const kubeconfig = path.join(stateInfraRoot(), "k8s-port-forward", "kubeconfig");
  if (isDir(kubeconfig)) {
    fs.rmSync(kubeconfig, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(kubeconfig), { recursive: true });
  info("Refreshing k8s-port-forward/kubeconfig from current context...");
  try {
    const result = run(["kubectl", "config", "view", "--raw", "--minify", "--flatten"], {
      capture: true,
      timeout: 10,
    });
    if (result.status === 0) {
      fs.writeFileSync(kubeconfig, shimLocalApiServer(result.stdout));
      const ctx = run(["kubectl", "--kubeconfig", kubeconfig, "config", "current-context"], {
        capture: true,
        timeout: 5,
      });
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
  return fs.existsSync(kubeconfig) && fs.statSync(kubeconfig).isFile();
}

/** True when the current kube context's API server answers within a few seconds. */
function clusterReachable(): boolean {
  try {
    return (
      run(["kubectl", "--request-timeout=3s", "get", "--raw", "/readyz"], {
        capture: true,
        timeout: 20,
      }).status === 0
    );
  } catch (e) {
    if (e instanceof ProcError) return false;
    throw e;
  }
}

/**
 * Verify the k8s-forwards container is healthy, restarting it if not.
 */
export async function ensurePortForwardsHealthy(): Promise<ForwardsOutcome> {
  const health = await checkPortForwardHealth();
  if (health["k8s-forwards"] ?? false) {
    success("k8s port-forwards container is healthy");
    return "healthy";
  }

  warn("k8s port-forwards container is unhealthy — restarting...");
  if (!refreshKubeconfig()) {
    error("Not restarting k8s-forwards without a kubeconfig file to mount");
    return "failed";
  }
  // A context whose cluster is switched off still yields a kubeconfig, so the
  // forwarder would restart and `up` would then time out waiting for tunnels
  // that can't connect. With no cluster there is nothing to forward: report the
  // non-fatal outcome and let features that need nothing from k8s come up (SW-28).
  if (!clusterReachable()) {
    warn(
      "No reachable k8s cluster — skipping port-forwards; services not run locally are unavailable",
    );
    return "failed";
  }
  const { argv, env, cwd } = composeInvocation();

  try {
    // --force-recreate, because plain `up -d` cannot repair the case this
    // function exists for. For a container that is already running with
    // unchanged config, compose reports "Running", does nothing, and exits 0 —
    // so an Up-but-unhealthy forwarder was reported "restarted" while nothing
    // had happened, and `up` then waited out its timeout for tunnels that were
    // never coming back. Recreating also re-reads the just-refreshed kubeconfig
    // and the forwards table, which a bare restart would not.
    const result = run([...argv, "up", "-d", "--force-recreate", "k8s-forwards"], {
      capture: true,
      timeout: 60,
      env,
      cwd,
    });
    if (result.status !== 0) {
      error(`Failed to restart k8s-forwards: ${result.stderr.trim()}`);
      return "failed";
    }
    success("k8s port-forwards container restarted");
    return "restarted";
  } catch (err) {
    if (err instanceof ProcError) {
      error(`Failed to restart k8s-forwards: ${err.message}`);
      return "failed";
    }
    throw err;
  }
}

/**
 * Poll every forward until all of them answer their probe, or *timeoutMs*
 * elapses.
 *
 * `docker compose up -d` returns when the container is running, but the
 * `kubectl port-forward` processes inside it reconnect asynchronously — in the
 * observed case a second later. Anything started in that window that needs a
 * datastore gets ECONNREFUSED, exhausts its retries and fails its healthcheck,
 * and the caller sees a compose dependency error that never mentions a
 * port-forward.
 *
 * Throws `FORWARDS_NEVER_READY` naming the forwards that never came back, so
 * the failure says what actually went wrong.
 */
export async function waitForForwards(timeoutMs = 30_000, pollMs = 500): Promise<void> {
  let pending = forwardSpecs();
  if (!pending.length) {
    return;
  }

  info("Waiting for port-forwards to reconnect...");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const checked = await Promise.all(
      pending.map(async (spec) => ({
        spec,
        ok: (await checkForwardHealth(spec.listen, spec.health)).ok,
      })),
    );
    // Only the ones still down are re-probed: a forward that has answered once
    // is up, and re-checking it would let a slow probe hold the whole poll.
    pending = checked.filter((c) => !c.ok).map((c) => c.spec);
    if (!pending.length) {
      success("k8s port-forwards are carrying traffic");
      return;
    }
    if (Date.now() >= deadline) {
      throw new SandboxError(
        `k8s port-forwards did not come back within ${Math.round(timeoutMs / 1000)}s: ` +
          `${pending.map((s) => `${s.name}:${s.listen}`).join(", ")}\n` +
          "       Check `docker logs sandbox-k8s-forwards` and your kubeconfig.",
        "FORWARDS_NEVER_READY",
      );
    }
    await sleep(pollMs);
  }
}

/** Return a human-readable status string for the k8s-forwards container. */
export async function getForwardsStatus(): Promise<string> {
  const health = await checkPortForwardHealth();
  if (health["k8s-forwards"] ?? false) {
    return `${Colors.GREEN}healthy${Colors.RESET}`;
  }
  return `${Colors.RED}down${Colors.RESET}`;
}

/**
 * Return true if HTTP GET to 127.0.0.1:port+path answers below 500.
 *
 * A 4xx counts as alive: it means the service answered and rejected the
 * request (`/graphql` without a query body, say), which still proves the
 * forward carries traffic — the only thing this probe is asked.
 */
function checkHttpHealth(
  port: number,
  pathName: string,
  timeoutMs = 3500,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathName, timeout: timeoutMs }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      resolve({ ok: code < 500, detail: `HTTP ${code}` });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: "timeout" });
    });
    req.on("error", (e) =>
      resolve({ ok: false, detail: (e as NodeJS.ErrnoException).code ?? e.message }),
    );
  });
}

/**
 * Probes for forwards that speak a protocol rather than HTTP. A TCP connect
 * proves nothing about them: a stale `kubectl port-forward` accepts the
 * connection and never replies, which is exactly the failure that reads as
 * healthy while every query hangs (docs/known-issues.md). Both exchanges are
 * pre-authentication, so neither needs credentials.
 */
export const WIRE_PROBES: Record<string, { send: Buffer; ok: (reply: Buffer) => boolean }> = {
  redis: { send: Buffer.from("PING\r\n"), ok: (r) => r.toString("latin1").startsWith("+PONG") },
  // SSLRequest: length 8, code 80877103. Answered with a single 'S' or 'N'
  // byte — either one proves a live server on the other end.
  postgres: {
    send: Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]),
    ok: (r) => r[0] === 0x53 || r[0] === 0x4e,
  },
};

/** Send a {@link WIRE_PROBES} probe and wait for the answer. */
export function checkWireHealth(
  port: number,
  kind: string,
  timeoutMs = 3500,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const probe = WIRE_PROBES[kind];
    const sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    sock.on("connect", () => sock.write(probe.send));
    sock.once("data", (reply: Buffer) => {
      sock.destroy();
      const ok = probe.ok(reply);
      resolve({ ok, detail: ok ? `${kind} ok` : `${kind} bad reply` });
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ ok: false, detail: "timeout (connected, no reply)" });
    });
    sock.on("error", (e) =>
      resolve({ ok: false, detail: (e as NodeJS.ErrnoException).code ?? e.message }),
    );
    // A peer that hangs up without a byte (Docker's port proxy before the tunnel
    // binds) fires none of the above; without this the probe never settles (#207).
    sock.on("close", () => resolve({ ok: false, detail: "closed without reply" }));
  });
}

function checkTcpHealth(port: number, timeoutMs = 2500): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    sock.on("connect", () => {
      sock.destroy();
      resolve({ ok: true, detail: "tcp open" });
    });
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ ok: false, detail: "timeout" });
    });
    sock.on("error", (e) =>
      resolve({ ok: false, detail: (e as NodeJS.ErrnoException).code ?? e.message }),
    );
  });
}

/**
 * Run the probe a forward's `health_endpoint` names: an HTTP path, a
 * {@link WIRE_PROBES} name, or blank for TCP-only.
 *
 * An unrecognised name fails rather than falling back to TCP — silently
 * downgrading to the probe that cannot see a dead forward is the bug this
 * question has already had twice, once as that fallback and once as
 * `classifyForward` reading a probe name as a URL path.
 */
export function checkForwardHealth(
  port: number,
  health: string,
): Promise<{ ok: boolean; detail: string }> {
  if (health.startsWith("/")) return checkHttpHealth(port, health);
  if (WIRE_PROBES[health]) return checkWireHealth(port, health);
  if (health) return Promise.resolve({ ok: false, detail: `unknown probe "${health}"` });
  return checkTcpHealth(port);
}

/** Return status string for a single forward. */
async function classifyForward(listenPort: number, healthPath: string): Promise<string> {
  return (await checkForwardHealth(listenPort, healthPath)).ok ? "alive" : "dead";
}

export interface ForwardStatus {
  name: string;
  listen_port: number;
  remote_port: number;
  health_path: string;
  status: string;
}

/**
 * Return per-service k8s port-forward health.
 *
 * For each forwarded service in the registry, performs an HTTP health check
 * against the published host port when a health_path is defined, or TCP-only
 * when it is blank (databases and the like). This catches tunnels that are
 * TCP-bound but not serving traffic.
 *
 * Returns a list of dicts with keys: name, listen_port, remote_port, health_path, status.
 * status is one of: "alive", "dead", "container_down", or "stopped" — the
 * container is down and no running feature needs it ({@link forwarderNeeded}).
 */
export async function getPerServiceStatus(): Promise<ForwardStatus[]> {
  const forwardsUp = await containerRunning("sandbox-k8s-forwards");

  let specs: ForwardSpec[];
  try {
    specs = forwardSpecs();
  } catch {
    // Unreadable registry — report nothing rather than probing a stale guess.
    return [];
  }

  const down = forwardsUp ? null : (await forwarderNeeded()) ? "container_down" : "stopped";
  const results: ForwardStatus[] = [];
  for (const spec of specs) {
    results.push({
      name: spec.name,
      listen_port: spec.listen,
      remote_port: spec.remote,
      health_path: spec.health,
      status: down ?? (await classifyForward(spec.listen, spec.health)),
    });
  }
  return results;
}
