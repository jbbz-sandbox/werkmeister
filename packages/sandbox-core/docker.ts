/**
 * Engine API access, via `dockerode`.
 *
 * Container state arrives as data instead of as `docker ps` / `docker stats`
 * text that has to be split on tabs and have its units re-parsed. Compose is
 * not here and does not belong here: it is a CLI plugin with no daemon
 * endpoint, and the graph it builds — `depends_on: service_healthy`, profiles,
 * BuildKit, `.env` interpolation — is a project to reimplement, not a refactor.
 */

import Dockerode, { type DockerOptions } from "dockerode";

import { ProcError, run } from "./proc.js";

/**
 * Where the daemon is.
 *
 * dockerode reads `DOCKER_HOST` or falls back to `/var/run/docker.sock`; it
 * knows nothing about `docker context`. On a machine whose active context is
 * not symlinked to the default socket — OrbStack, Colima, a remote context —
 * that silently addresses a *different daemon* than the `docker` CLI does, so
 * the CLI is asked instead. `docker context inspect` already reports
 * `DOCKER_HOST` when it is set (as a synthetic `default` context), so one call
 * covers both; the env var is only consulted when the CLI is missing entirely.
 */
export function resolveEndpoint(): DockerOptions {
  return endpointOptions(contextHost() ?? process.env.DOCKER_HOST ?? "");
}

function contextHost(): string | null {
  try {
    const result = run(
      ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { capture: true, timeout: 10 },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
  } catch (err) {
    if (err instanceof ProcError) return null; // no docker CLI, or it hung
    throw err;
  }
}

/** Split out from `resolveEndpoint` so the URL forms are testable without a daemon. */
export function endpointOptions(host: string): DockerOptions {
  if (host.startsWith("unix://")) {
    return { socketPath: host.slice("unix://".length) };
  }
  if (/^(tcp|http|https):\/\//.test(host)) {
    const url = new URL(host);
    const https = url.protocol === "https:";
    return {
      host: url.hostname,
      port: Number(url.port) || (https ? 2376 : 2375),
      protocol: https ? "https" : "http",
    };
  }
  // ponytail: unix and tcp only. An `ssh://` context needs dockerode's ssh2
  // transport, which the VS Code extension's single-file bundle can't carry;
  // add the branch when a machine actually runs one.
  return { socketPath: "/var/run/docker.sock" };
}

let client: Dockerode | null = null;

/** The shared client. The endpoint is resolved once, on first use. */
export function docker(): Dockerode {
  return (client ??= new Dockerode(resolveEndpoint()));
}

/** True when a container of this exact name exists and is running. */
export async function containerRunning(name: string): Promise<boolean> {
  try {
    const info = await docker().getContainer(name).inspect();
    return info.State.Running === true;
  } catch {
    // No such container, or no reachable daemon — both mean "not running",
    // which is what the `docker inspect` exit code said before.
    return false;
  }
}

export interface ContainerStat {
  name: string;
  cpuPercent: number;
  memMib: number;
  memLimitMib: number;
}

const MIB = 1024 * 1024;

/**
 * CPU share over the sample window, as `docker stats` computes it: the
 * container's CPU-time delta against the host's, scaled by the core count.
 */
export function cpuPercent(s: Dockerode.ContainerStats): number {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const systemDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  const cores = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

/**
 * Resident memory in MiB, excluding page cache — the subtraction is what makes
 * this agree with `docker stats`. cgroup v2 reports the cache as
 * `inactive_file`, v1 as `total_inactive_file`/`cache`.
 */
export function memMib(s: Dockerode.ContainerStats): number {
  const st = (s.memory_stats.stats ?? {}) as Record<string, number>;
  const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
  return ((s.memory_stats.usage ?? 0) - cache) / MIB;
}

/**
 * One stats sample for every running container.
 *
 * Each call costs about a second: the daemon samples twice to produce the CPU
 * delta, exactly as `docker stats --no-stream` does. They run concurrently, so
 * the wall clock is one sample, not one per container.
 */
export async function containerStats(): Promise<ContainerStat[]> {
  let running: Dockerode.ContainerInfo[];
  try {
    running = await docker().listContainers();
  } catch {
    return []; // daemon unreachable — the caller reports an empty table
  }

  const stats = await Promise.all(
    running.map(async (c) => {
      try {
        const s = await docker().getContainer(c.Id).stats({ stream: false });
        return {
          name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
          cpuPercent: cpuPercent(s),
          memMib: memMib(s),
          memLimitMib: (s.memory_stats.limit ?? 0) / MIB,
        };
      } catch {
        return null; // container exited between the list and the sample
      }
    }),
  );
  return stats.filter((s): s is ContainerStat => s !== null);
}

/** Every volume name known to the daemon, or `null` when it is unreachable. */
export async function listVolumeNames(): Promise<string[] | null> {
  try {
    const { Volumes } = await docker().listVolumes();
    return (Volumes ?? []).map((v) => v.Name);
  } catch {
    return null;
  }
}

/** Remove one volume. False when it is in use, already gone, or unreachable. */
export async function removeVolume(name: string): Promise<boolean> {
  try {
    await docker().getVolume(name).remove();
    return true;
  } catch {
    return false;
  }
}
