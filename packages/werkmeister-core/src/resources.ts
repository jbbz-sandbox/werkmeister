/**
 * Per-workspace container vitals (SW-41): CPU and memory from one stats sweep,
 * when and by what the containers were started, and crash loops.
 *
 * Two reads with different costs, kept apart on purpose. `projectHealth` is
 * listing + inspect metadata, cheap enough for every 5 s status poll, so a crash
 * loop shows within one poll. `getWorkspaceResources` samples CPU, which costs
 * the daemon about a second when healthy and took minutes under the 2026-10-18
 * load; surfaces run it on their own slower clock so it can never cost the rows.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type ContainerRuntime,
  type ContainerStat,
  containerRuntime,
  containerStats,
  lastLogLine,
  type ProjectContainer,
} from "./docker.js";
import { dotDir } from "./dot_dir.js";
import { labelOf } from "./slots.js";

export type StartedBy = "up" | "gate" | "restart" | "person";

export interface Started {
  /** ISO time the earliest running container started. */
  at: string;
  by: StartedBy;
}

export interface CrashLoop {
  service: string;
  restarts: number;
  lastLog: string | null;
}

export interface ProjectHealth {
  started: Started | null;
  crashLoops: CrashLoop[];
}

export interface Usage {
  /** Percent of one core, summed over the project's containers, as `docker stats` reports it. */
  cpuPercent: number;
  memMib: number;
}

export interface HostSummary {
  /** `os.loadavg()`: 1, 5 and 15 minutes. */
  load: [number, number, number];
  cores: number;
  /** Every feature container's CPU summed, shared infra excluded. */
  featureCpuPercent: number;
}

export interface WorkspaceResources {
  /** Keyed by compose project, `WorkspaceStatus.project`. */
  projects: Record<string, Usage>;
  host: HostSummary;
}

/** One werkmeister command's compose start, `from`/`to` ISO. */
export interface StartRecord {
  by: Exclude<StartedBy, "person">;
  from: string;
  to: string;
}

const MAX_STARTS = 10;
/** Docker Desktop's VM clock tracks the host's closely, not exactly. */
const CLOCK_SLACK_MS = 2000;
/** A restart longer ago than this, on a container still running, is history rather than a loop. */
export const CRASH_WINDOW_MS = 5 * 60_000;

/** No compose label records who started a container (labels are fixed at create), so werkmeister keeps its own log. */
export function startsFile(workspace: string): string {
  return path.join(dotDir(workspace), "starts.json");
}

export function readStarts(workspace: string): StartRecord[] {
  try {
    const list = JSON.parse(fs.readFileSync(startsFile(workspace), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * A history rather than one marker: `up` on containers already running starts
 * nothing, and overwriting the record that did start them would relabel them `person`.
 */
export function recordStart(
  workspace: string,
  by: StartRecord["by"],
  fromMs: number,
  toMs: number = Date.now(),
): void {
  try {
    const file = startsFile(workspace);
    const list = [
      ...readStarts(workspace),
      { by, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    ].slice(-MAX_STARTS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  } catch {
    // A start must never fail over its bookkeeping; the row then reads `person`.
  }
}

/** Recorded in `finally`: a compose call that fails part-way can still have started containers. */
export async function withStartRecord<T>(
  workspace: string,
  by: StartRecord["by"],
  work: () => Promise<T>,
): Promise<T> {
  const from = Date.now();
  try {
    return await work();
  } finally {
    recordStart(workspace, by, from);
  }
}

/** The newest record whose window holds *startedAt*; `person` when none does. */
export function startedBy(startedAt: number, starts: StartRecord[]): StartedBy {
  for (let i = starts.length - 1; i >= 0; i--) {
    const s = starts[i];
    if (
      startedAt >= Date.parse(s.from) - CLOCK_SLACK_MS &&
      startedAt <= Date.parse(s.to) + CLOCK_SLACK_MS
    )
      return s.by;
  }
  return "person";
}

/**
 * Stateless, so one read decides it: any restart count is a policy restart since
 * the last explicit start. Not running after restarts means a capped policy
 * (`on-failure:3`) gave up.
 */
export function isCrashLoop(
  c: Pick<ProjectContainer, "state">,
  rt: ContainerRuntime | undefined,
  now: number,
): boolean {
  if (c.state === "restarting") return true;
  if (!rt || rt.restartCount === 0) return false;
  return c.state !== "running" || now - rt.startedAt < CRASH_WINDOW_MS;
}

/** Live containers, plus exited failures whose restart count says whether they looped. */
function worthInspecting(c: ProjectContainer): boolean {
  return (
    c.state === "running" || c.state === "restarting" || (c.state === "exited" && c.exitCode !== 0)
  );
}

/** Pure half of {@link projectHealth}; `lastLog` is left null. */
export function healthOf(
  containers: ProjectContainer[],
  runtime: Map<string, ContainerRuntime>,
  startsOf: (workingDir: string) => StartRecord[],
  now: number,
): Map<string, ProjectHealth> {
  const out = new Map<string, ProjectHealth>();
  const earliest = new Map<string, { at: number; workingDir: string }>();
  for (const c of containers) {
    const project = c.labels["com.docker.compose.project"];
    if (!project) continue;
    const h = out.get(project) ?? { started: null, crashLoops: [] };
    out.set(project, h);
    const rt = runtime.get(c.name);
    if (isCrashLoop(c, rt, now))
      h.crashLoops.push({ service: c.service, restarts: rt?.restartCount ?? 0, lastLog: null });
    if (c.state !== "running" || !rt || Number.isNaN(rt.startedAt)) continue;
    const first = earliest.get(project);
    if (!first || rt.startedAt < first.at)
      earliest.set(project, {
        at: rt.startedAt,
        workingDir: c.labels["com.docker.compose.project.working_dir"] ?? "",
      });
  }
  for (const [project, { at, workingDir }] of earliest) {
    const h = out.get(project) as ProjectHealth;
    h.started = {
      at: new Date(at).toISOString(),
      by: workingDir ? startedBy(at, startsOf(workingDir)) : "person",
    };
  }
  for (const h of out.values()) h.crashLoops.sort((a, b) => a.service.localeCompare(b.service));
  return out;
}

/** Start reason and crash loops per compose project, from a listing the caller already made. */
export async function projectHealth(
  containers: ProjectContainer[],
  now: number = Date.now(),
): Promise<Map<string, ProjectHealth>> {
  const inspected = containers.filter(worthInspecting);
  const runtime = await containerRuntime(inspected.map((c) => c.name));
  const health = healthOf(inspected, runtime, readStarts, now);
  // Logs only for the crash loops: one call per broken container, none per healthy one.
  await Promise.all(
    inspected
      .filter((c) => isCrashLoop(c, runtime.get(c.name), now))
      .map(async (c) => {
        const loop = health
          .get(c.labels["com.docker.compose.project"])
          ?.crashLoops.find((l) => l.service === c.service && l.lastLog === null);
        if (loop) loop.lastLog = await lastLogLine(c.name, runtime.get(c.name)?.tty ?? false);
      }),
  );
  return health;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function usageByProject(stats: ContainerStat[]): Record<string, Usage> {
  const out: Record<string, Usage> = {};
  for (const s of stats) {
    const project = s.labels["com.docker.compose.project"];
    if (!project) continue;
    const u = (out[project] ??= { cpuPercent: 0, memMib: 0 });
    u.cpuPercent += s.cpuPercent;
    u.memMib += s.memMib;
  }
  for (const u of Object.values(out)) {
    u.cpuPercent = round1(u.cpuPercent);
    u.memMib = Math.round(u.memMib);
  }
  return out;
}

export function hostSummary(
  stats: ContainerStat[],
  load: number[] = os.loadavg(),
  cores: number = os.availableParallelism(),
): HostSummary {
  const feature = stats.filter((s) => {
    const f = labelOf(s.labels, "feature");
    return f && f !== "infra";
  });
  return {
    load: [round1(load[0]), round1(load[1]), round1(load[2])],
    cores,
    featureCpuPercent: round1(feature.reduce((sum, s) => sum + s.cpuPercent, 0)),
  };
}

/**
 * One stats sweep, as `docker stats --no-stream` makes it, for every workspace at
 * once. Cut off after *timeoutMs*: a wedged daemon gives partial numbers, never a hang.
 */
export async function getWorkspaceResources(timeoutMs = 20_000): Promise<WorkspaceResources> {
  const stats = await containerStats(AbortSignal.timeout(timeoutMs));
  return { projects: usageByProject(stats), host: hostSummary(stats) };
}
