/**
 * Engine API access, via `dockerode`.
 *
 * Container state arrives as data instead of as `docker ps` / `docker stats`
 * text that has to be split on tabs and have its units re-parsed. That includes
 * reading a compose project's containers: compose labels every container it
 * creates, so state, health and ports are a label filter away, with no compose
 * file or argv. Compose orchestration is not here and does not belong here: it
 * is a CLI plugin with no daemon endpoint, and the graph it builds —
 * `depends_on: service_healthy`, profiles, BuildKit, `.env` interpolation — is a
 * project to reimplement, not a refactor.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import Dockerode, { type DockerOptions } from "dockerode";
import * as tar from "tar-fs";

import { BLUE, CYAN, GREEN, MAGENTA, RESET, YELLOW } from "./colors.js";
import { ProcError, run } from "./proc.js";

/**
 * Where the daemon is.
 *
 * dockerode reads `DOCKER_HOST` or falls back to `/var/run/docker.sock`; it
 * knows nothing about `docker context`. On a machine whose active context is
 * not symlinked to the default socket — OrbStack, Colima, a remote context —
 * that silently addresses a *different daemon* than the `docker` CLI does, so
 * the active context has to be resolved first.
 *
 * The CLI is the fallback rather than the first choice: spawning it costs ~50ms
 * of Go startup, which a short-lived `werkmeister` command pays on every run to
 * learn something two file reads already know.
 */
export function resolveEndpoint(): DockerOptions {
  // SW-259: a test reading the host engine sees other workspaces' containers and fails at random.
  if (process.env.NODE_TEST_CONTEXT && !process.env.WERKMEISTER_DOCKER_ENGINE) {
    process.stderr.write(
      "Docker engine reached in a test without useDockerEngine() (fixtures.mjs); using a dead socket\n",
    );
    // docker-modem fills `host` from a tcp DOCKER_HOST, and `host` beats `socketPath`.
    return { socketPath: TEST_DEAD_SOCKET, host: undefined };
  }
  return endpointOptions(storeContextHost() ?? cliContextHost() ?? "");
}

const TEST_DEAD_SOCKET = "/nonexistent/werkmeister-test-docker.sock";

/** The built-in `default` context: no meta.json on disk, it *is* the local socket. */
const DEFAULT_CONTEXT_HOST = "unix:///var/run/docker.sock";

/**
 * The active context's endpoint, read from the files the CLI itself reads.
 *
 * `docker context inspect` is a JSON dump of two files, so reading them
 * directly gets the same answer without the spawn — and without a cache, so
 * `docker context use` takes effect on the next call instead of whenever a TTL
 * happens to expire. The layout: `config.json` names the active context, and
 * each context's endpoint lives at `contexts/meta/<sha256(name)>/meta.json`.
 *
 * Anything unexpected — missing file, unfamiliar shape — returns null so the
 * caller falls back to asking the CLI. Addressing the *wrong* daemon is the
 * failure this resolution exists to prevent, and 50ms is the cheaper mistake.
 */
function storeContextHost(): string | null {
  // Docker's own precedence: DOCKER_HOST overrides context selection entirely.
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  try {
    const configDir = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
    const name = process.env.DOCKER_CONTEXT || currentContextName(configDir);
    if (name === "default") return DEFAULT_CONTEXT_HOST;
    const digest = createHash("sha256").update(name).digest("hex");
    const meta = JSON.parse(
      readFileSync(path.join(configDir, "contexts", "meta", digest, "meta.json"), "utf8"),
    );
    const host = meta?.Endpoints?.docker?.Host;
    return typeof host === "string" && host ? host : null;
  } catch {
    return null;
  }
}

/** A missing config and an absent key both mean the `default` context, as they do for the CLI. */
function currentContextName(configDir: string): string {
  try {
    const config = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
    return config?.currentContext || "default";
  } catch {
    return "default";
  }
}

function cliContextHost(): string | null {
  try {
    const result = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      capture: true,
      // A load-starved CLI read as "no context" addresses the wrong daemon (SW-294).
      timeout: 30,
    });
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

/** One compose container, with the fields `docker compose ps --format json` reports. */
export interface ProjectContainer {
  name: string;
  state: string;
  /** `healthy` | `unhealthy` | `starting`, or `""` when the container declares no healthcheck. */
  health: string;
  ports: string;
  service: string;
  labels: Record<string, string>;
  /** The `Exited (N)` code; 0 for a container that hasn't exited, as compose reports it. */
  exitCode: number;
}

/**
 * A compose project's containers, found by the labels compose stamps on them.
 * `null` when the daemon can't be reached.
 *
 * No *project* lists every compose project's containers. `all: false` lists only
 * live ones (running, paused, restarting), the set `compose ps` without `-a` shows.
 */
export async function projectContainers(
  project?: string,
  service?: string,
  { all = true }: { all?: boolean } = {},
): Promise<ProjectContainer[] | null> {
  const label = [
    project ? `com.docker.compose.project=${project}` : "com.docker.compose.project",
    // `compose run` leftovers, which `compose ps` leaves out too.
    "com.docker.compose.oneoff=False",
    ...(service ? [`com.docker.compose.service=${service}`] : []),
  ];
  try {
    const found = await withTimeout(
      10,
      "docker ps",
      docker().listContainers({ all, filters: { label } }),
    );
    // Newest first from the Engine; compose lists by name.
    return found
      .map(containerRecord)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return null;
  }
}

/** Split out from {@link projectContainers} so the mapping is testable without a daemon. */
export function containerRecord(c: Dockerode.ContainerInfo): ProjectContainer {
  const labels = c.Labels ?? {};
  // `listContainers` carries no health or exit code fields; both live in the
  // `Status` text ("Up 2 hours (healthy)", "Exited (137) 5 minutes ago"), which
  // saves an inspect per container.
  const status = c.Status ?? "";
  return {
    name: c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    state: c.State ?? "",
    health: parseHealth(status),
    ports: displayPorts(c.Ports ?? []),
    service: labels["com.docker.compose.service"] ?? "",
    labels,
    exitCode: Number(/^\s*Exited \((\d+)\)/.exec(status)?.[1] ?? 0),
  };
}

function parseHealth(status: string): string {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  if (!m) return "";
  return m[1] === "health: starting" ? "starting" : m[1];
}

/**
 * The `Ports` column as `docker ps` and `compose ps` print it
 * (`0.0.0.0:80->80/tcp, [::]:80->80/tcp, 443/udp`), which the CLI and dashboard
 * display. A port of docker/cli's `DisplayablePorts`, ordering and range
 * grouping included, so the string doesn't change under them.
 */
export function displayPorts(ports: Dockerode.Port[]): string {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...ports].sort(
    (a, b) =>
      a.PrivatePort - b.PrivatePort ||
      cmp(a.IP ?? "", b.IP ?? "") ||
      (a.PublicPort ?? 0) - (b.PublicPort ?? 0) ||
      cmp(a.Type, b.Type),
  );
  // Map keeps first-insertion order on re-set, as Go's `groupMapKeys` does.
  const groups = new Map<string, { first: number; last: number }>();
  const out: string[] = [];
  const hostMappings: string[] = [];
  for (const p of sorted) {
    const port = p.PrivatePort;
    if (p.IP && p.PublicPort !== port) {
      hostMappings.push(`${hostPort(p.IP, String(p.PublicPort))}->${port}/${p.Type}`);
      continue;
    }
    const key = p.IP ? `${p.IP}/${p.Type}` : p.Type;
    const g = groups.get(key);
    if (g && port === g.last + 1) {
      g.last = port;
      continue;
    }
    if (g) out.push(portGroup(key, g));
    groups.set(key, { first: port, last: port });
  }
  for (const [key, g] of groups) out.push(portGroup(key, g));
  return [...out, ...hostMappings].join(", ");
}

function portGroup(key: string, { first, last }: { first: number; last: number }): string {
  const [ip, type] = key.includes("/") ? key.split("/") : ["", key];
  const range = first === last ? `${first}` : `${first}-${last}`;
  return ip ? `${hostPort(ip, range)}->${range}/${type}` : `${range}/${type}`;
}

/** Go's `net.JoinHostPort`: IPv6 addresses get brackets. */
function hostPort(ip: string, port: string): string {
  return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
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
  labels: Record<string, string>;
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
 *
 * *signal* cancels the requests in flight: on a loaded daemon one snapshot runs
 * for tens of seconds. An aborted snapshot comes back partial or empty.
 */
export async function containerStats(signal?: AbortSignal): Promise<ContainerStat[]> {
  let running: Dockerode.ContainerInfo[];
  try {
    running = await docker().listContainers({ abortSignal: signal });
  } catch {
    return []; // daemon unreachable — the caller reports an empty table
  }

  // @types/dockerode leaves `abortSignal` off stats() though dockerode passes it
  // through; a non-literal options object gets past the excess-property check.
  const sampleOptions = { stream: false as const, abortSignal: signal };
  const stats = await Promise.all(
    running.map(async (c) => {
      try {
        const s = await docker().getContainer(c.Id).stats(sampleOptions);
        return {
          name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
          cpuPercent: cpuPercent(s),
          memMib: memMib(s),
          memLimitMib: (s.memory_stats.limit ?? 0) / MIB,
          labels: c.Labels ?? {},
        };
      } catch {
        return null; // container exited between the list and the sample
      }
    }),
  );
  return stats.filter((s): s is ContainerStat => s !== null);
}

/** What only `inspect` knows about a container: the listing carries none of it. */
export interface ContainerRuntime {
  /** `State.StartedAt`, epoch ms. */
  startedAt: number;
  /** Restart-policy restarts since the last explicit start; the daemon resets it on `docker start`. */
  restartCount: number;
  tty: boolean;
}

/** One concurrent `inspect` per name; a container that can't be inspected is left out. */
export async function containerRuntime(names: string[]): Promise<Map<string, ContainerRuntime>> {
  const found = await Promise.all(
    names.map(async (name) => {
      try {
        const i = await withTimeout(10, "docker inspect", docker().getContainer(name).inspect());
        const rt: ContainerRuntime = {
          startedAt: Date.parse(i.State.StartedAt),
          restartCount: i.RestartCount ?? 0,
          tty: i.Config.Tty,
        };
        return [name, rt] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(found.filter((e) => e !== null));
}

/** The container's last log line (stdout or stderr), at most 200 chars; null when there is none. */
export async function lastLogLine(name: string, tty: boolean): Promise<string | null> {
  try {
    const buf = await withTimeout(
      10,
      "docker logs",
      docker().getContainer(name).logs({ stdout: true, stderr: true, tail: 1, follow: false }),
    );
    let last: string | null = null;
    await pipeLogLines(Readable.from([buf]), tty, "", (line) => {
      if (line.trim()) last = line.trim().slice(0, 200);
    });
    return last;
  } catch {
    return null;
  }
}

/**
 * A daemon on the far end of a socket can stall. The shelled-out calls this
 * replaced passed `timeout` to spawnSync and reported it; dockerode's own
 * `timeout` option is per-connection and would cut off a follow stream, so the
 * deadline is applied per call instead.
 */
function withTimeout<T>(seconds: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${seconds} seconds`)),
      seconds * 1000,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export type LogStream = "stdout" | "stderr";
/** One finished, prefixed log line, without its newline. */
export type OnLogLine = (line: string, stream: LogStream) => void;

/**
 * The prefix name `compose logs` prints: a default `<project>-<svc>-<n>` name
 * loses the project, a custom `container_name` is printed whole.
 */
export function logName({ name, labels }: Pick<ProjectContainer, "name" | "labels">): string {
  const project = labels["com.docker.compose.project"];
  const svcNum = `${labels["com.docker.compose.service"]}-${labels["com.docker.compose.container-number"]}`;
  return name === `${project}-${svcNum}` ? svcNum : name;
}

// Compose's own cycle. Picked by a hash of the name rather than compose's
// first-come order, so a service keeps its colour when another is added.
const LOG_COLORS = [CYAN, YELLOW, GREEN, MAGENTA, BLUE];

/** `name | ` padded to *width*, as compose prints it, optionally in the name's colour. */
export function logPrefix(name: string, width: number, color: boolean): string {
  const text = `${name.padEnd(width)} | `;
  if (!color) return text;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `${LOG_COLORS[hash % LOG_COLORS.length]}${text}${RESET}`;
}

/** A write target for `demuxStream` that hands out whole lines, holding a partial one until it ends. */
function lineSink(prefix: string, stream: LogStream, onLine: OnLogLine) {
  // A multi-byte character can straddle two chunks.
  const decoder = new StringDecoder("utf8");
  let partial = "";
  const emit = (text: string) => {
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) onLine(prefix + line.replace(/\r$/, ""), stream);
  };
  return {
    write: (chunk: Buffer) => {
      emit(decoder.write(chunk));
      return true;
    },
    flush: () => {
      emit(decoder.end());
      if (partial) onLine(prefix + partial, stream);
      partial = "";
    },
  };
}

/**
 * Split one container's log stream into prefixed lines; resolves when it ends.
 *
 * A non-TTY container's stream interleaves stdout and stderr in 8-byte-header
 * frames. A TTY container's is raw bytes, which the demuxer would misread as
 * headers, so it must not go through it.
 */
export function pipeLogLines(
  raw: NodeJS.ReadableStream,
  tty: boolean,
  prefix: string,
  onLine: OnLogLine,
): Promise<void> {
  const out = lineSink(prefix, "stdout", onLine);
  const err = lineSink(prefix, "stderr", onLine);
  if (tty) raw.on("data", out.write);
  // demuxStream only ever calls write(), so the sinks need nothing more.
  else
    docker().modem.demuxStream(
      raw,
      out as unknown as NodeJS.WritableStream,
      err as unknown as NodeJS.WritableStream,
    );
  return new Promise((resolve) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      out.flush();
      err.flush();
      resolve();
    };
    raw.once("end", end);
    raw.once("close", end);
    // An abort lands here; the lines already read stand.
    raw.once("error", end);
  });
}

export interface ContainerLogsOptions {
  /** Keep streaming, and attach to containers that start later, until *signal* aborts. */
  follow: boolean;
  /** Lines of backlog per container. */
  tail: number;
  signal?: AbortSignal;
  color: boolean;
}

/**
 * `docker compose logs [-f] --tail N [service]` over the Engine API: one stream
 * per container of *project*, merged as they arrive.
 *
 * Without `follow` it resolves once every backlog is out. With it, it runs until
 * *signal* aborts, attaching to each container that starts meanwhile, which is
 * what keeps a tail alive across `werkmeister feature restart`. No containers, or an unknown
 * *service*, is one stderr line, as compose prints one.
 */
export async function containerLogs(
  project: string,
  service: string | null,
  { follow, tail, signal, color }: ContainerLogsOptions,
  onLine: OnLogLine,
): Promise<void> {
  const label = [
    `com.docker.compose.project=${project}`,
    "com.docker.compose.oneoff=False",
    ...(service ? [`com.docker.compose.service=${service}`] : []),
  ];
  // Subscribed before listing, so a container starting in between isn't missed.
  const events = follow
    ? await docker()
        .getEvents({
          filters: { type: ["container"], event: ["start"], label },
          abortSignal: signal,
        } as Dockerode.GetEventsOptions)
        .catch(() => null)
    : null;

  const found = await projectContainers(project, service ?? undefined);
  if (found === null || found.length === 0) {
    events?.removeAllListeners();
    (events as Readable | null)?.destroy();
    onLine(
      found === null
        ? "cannot reach the docker daemon"
        : service
          ? `no such service: ${service}`
          : `no containers for project ${project}`,
      "stderr",
    );
    return;
  }

  let width = Math.max(...found.map((c) => logName(c).length));
  const attached = new Set<string>();
  const running = new Set<Promise<void>>();

  const attach = (name: string, prefixName: string, since?: number) => {
    if (attached.has(name) || signal?.aborted) return;
    attached.add(name);
    width = Math.max(width, prefixName.length);
    const piped = (async () => {
      const container = docker().getContainer(name);
      const { Config } = await container.inspect();
      // A re-attach after a restart reads from the start event on, not the backlog again.
      const range = since === undefined ? { tail } : { since };
      const base = { stdout: true, stderr: true, ...range, abortSignal: signal };
      const raw = follow
        ? await container.logs({ ...base, follow: true })
        : Readable.from([await container.logs({ ...base, follow: false })]);
      await pipeLogLines(raw, Config.Tty, logPrefix(prefixName, width, color), onLine);
    })()
      // Aborted, or the container went away between the list and the attach.
      .catch(() => {})
      .finally(() => {
        attached.delete(name);
        running.delete(piped);
      });
    running.add(piped);
  };

  for (const c of found) attach(c.name, logName(c));

  if (follow) {
    let pending = "";
    events?.on("data", (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        const attrs = e.Actor?.Attributes ?? {};
        attach(attrs.name, logName({ name: attrs.name, labels: attrs }), e.time);
      }
    });
    events?.on("error", () => {});
    // No signal follows forever, as `compose logs -f` does; every caller passes one.
    if (!signal?.aborted) {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
  }
  while (running.size > 0) await Promise.all(running);
}

/**
 * Copy one host file into a container, as `docker cp <file> <container>:<path>`
 * does. The Engine API takes a tar stream, so the file is packed into one whose
 * single entry is renamed to the destination's basename.
 */
export async function copyFileToContainer(
  container: string,
  hostPath: string,
  containerPath: string,
): Promise<void> {
  const pack = tar.pack(path.dirname(hostPath), {
    entries: [path.basename(hostPath)],
    map: (header) => ({ ...header, name: path.basename(containerPath) }),
  });
  await withTimeout(
    30,
    "docker cp",
    docker()
      .getContainer(container)
      .putArchive(pack, { path: path.dirname(containerPath) }),
  );
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command inside a running container and capture what it wrote.
 *
 * The attach stream carries both pipes in one connection, tagged per frame, so
 * it has to be demultiplexed to tell stdout from stderr — and it has to drain
 * before the exit code is readable.
 */
export async function execCapture(container: string, cmd: string[]): Promise<ExecResult> {
  return withTimeout(
    30,
    cmd.slice(0, 2).join(" "),
    (async () => {
      const exec = await docker()
        .getContainer(container)
        .exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({});

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const outPipe = new PassThrough().on("data", (c: Buffer) => out.push(c));
      const errPipe = new PassThrough().on("data", (c: Buffer) => err.push(c));
      docker().modem.demuxStream(stream, outPipe, errPipe);

      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      const { ExitCode } = await exec.inspect();
      return {
        exitCode: ExitCode ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
    })(),
  );
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

export interface VolumeUsage {
  size: number;
  createdAt: string;
}

/** Size and creation time per volume, from one `docker system df`; null when unreachable. */
export async function volumeUsage(): Promise<Map<string, VolumeUsage> | null> {
  try {
    const { Volumes } = (await docker().df()) as {
      Volumes?: { Name: string; CreatedAt: string; UsageData?: { Size?: number } }[];
    };
    return new Map(
      (Volumes ?? []).map((v) => [
        v.Name,
        { size: v.UsageData?.Size ?? -1, createdAt: v.CreatedAt },
      ]),
    );
  } catch {
    return null;
  }
}

/**
 * Names of the running containers that mount the volume or host dir *source*;
 * null when unreachable. Matched on each mount rather than the `volume` filter,
 * which matches a bind by its destination, not its host dir.
 */
export async function runningContainersMounting(source: string): Promise<string[] | null> {
  try {
    const list = await docker().listContainers({ filters: { status: ["running"] } });
    return list
      .filter((c) => (c.Mounts ?? []).some((m) => m.Name === source || m.Source === source))
      .map((c) => (c.Names[0] ?? c.Id).replace(/^\//, ""));
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
