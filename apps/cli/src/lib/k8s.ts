/**
 * k8s port-forward management for the developer sandbox.
 *
 * Port-forwards run inside a Docker container (k8s-forwards) as part of the
 * shared infrastructure (compose/shared-infra.yml). This module provides
 * health-check and status utilities for that container.
 */

import * as net from "node:net";
import * as path from "node:path";

import { Colors, error, getInfraRoot, success, warn } from "./config.js";
import { forwardSpecs, type ForwardSpec } from "./k8s_forwards.js";
import { containerRunning } from "sandbox-core/docker";
import { ProcError, run } from "sandbox-core/proc";

// The forward table is NOT duplicated here: `forwardSpecs()` derives it from
// ~/.sandbox/services.yaml — the same call that generates the entrypoint's
// data file and shared-infra.yml's ports/aliases, so health checks can never
// probe a service the container isn't actually forwarding.

function infraComposeFile(): string {
  return path.join(getInfraRoot(), "compose", "shared-infra.yml");
}

/**
 * Check the health of the containerized k8s-forwards service.
 *
 * Queries Docker to determine the container's health status and
 * returns a dict with the container name and its health state.
 */
export function checkPortForwardHealth(): Record<string, boolean> {
  const composeFile = infraComposeFile();
  const results: Record<string, boolean> = {};

  try {
    const result = run(
      [
        "docker", "compose", "-f", composeFile,
        "ps", "--format", "json", "k8s-forwards",
      ],
      { capture: true, timeout: 10 },
    );
    if (result.status === 0 && result.stdout.trim()) {
      for (const line of result.stdout.trim().split("\n")) {
        try {
          const svc = JSON.parse(line);
          const health = svc["Health"] ?? "";
          const state = svc["State"] ?? "";
          results["k8s-forwards"] =
            health === "healthy" || (state === "running" && health === "");
        } catch {
          continue;
        }
      }
    }
  } catch (err) {
    if (!(err instanceof ProcError)) throw err; // timeout / missing docker → fall through
  }

  if (!("k8s-forwards" in results)) {
    results["k8s-forwards"] = false;
  }

  return results;
}

/**
 * Verify the k8s-forwards container is healthy.
 *
 * If unhealthy, attempts to restart it via docker compose.
 *
 * Returns true if the container is healthy (or was successfully restarted).
 */
export function ensurePortForwardsHealthy(): boolean {
  const health = checkPortForwardHealth();
  if (health["k8s-forwards"] ?? false) {
    success("k8s port-forwards container is healthy");
    return true;
  }

  warn("k8s port-forwards container is unhealthy — restarting...");
  const composeFile = infraComposeFile();

  try {
    const result = run(
      ["docker", "compose", "-f", composeFile, "up", "-d", "k8s-forwards"],
      { capture: true, timeout: 60 },
    );
    if (result.status !== 0) {
      error(`Failed to restart k8s-forwards: ${result.stderr.trim()}`);
      return false;
    }
    success("k8s port-forwards container restarted");
    return true;
  } catch (err) {
    if (err instanceof ProcError) {
      error(`Failed to restart k8s-forwards: ${err.message}`);
      return false;
    }
    throw err;
  }
}

/** Return a human-readable status string for the k8s-forwards container. */
export function getForwardsStatus(): string {
  const health = checkPortForwardHealth();
  if (health["k8s-forwards"] ?? false) {
    return `${Colors.GREEN}healthy${Colors.RESET}`;
  }
  return `${Colors.RED}down${Colors.RESET}`;
}

/** Return true if a TCP connection to localhost:port succeeds. */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "localhost", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Return true if HTTP GET to localhost:port+path returns 2xx-4xx.
 *
 * Accepts any non-5xx response — 4xx means the service is alive but rejected
 * the request (e.g. /graphql without a query body), which is fine.
 */
async function httpCheck(port: number, healthPath: string): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}${healthPath}`, {
      signal: AbortSignal.timeout(3000),
    });
    return resp.status < 500;
  } catch {
    return false;
  }
}

/**
 * Return status string for a single forward.
 *
 * Uses HTTP GET via health_path when available (accepts 2xx-4xx);
 * falls back to TCP-only for services with no health_path (e.g. mongodb).
 */
async function classifyForward(listenPort: number, healthPath: string): Promise<string> {
  if (!(await portOpen(listenPort))) {
    return "dead";
  }
  if (healthPath) {
    return (await httpCheck(listenPort, healthPath)) ? "alive" : "dead";
  }
  return "alive";
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
 * status is one of: "alive", "dead", "container_down".
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

  const results: ForwardStatus[] = [];
  for (const spec of specs) {
    results.push({
      name: spec.name,
      listen_port: spec.listen,
      remote_port: spec.remote,
      health_path: spec.health,
      status: forwardsUp
        ? await classifyForward(spec.listen, spec.health)
        : "container_down",
    });
  }
  return results;
}
