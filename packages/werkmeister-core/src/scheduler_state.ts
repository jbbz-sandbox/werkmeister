/**
 * File-backed scheduler state (SW-181), under `~/.werkmeister/scheduler/`:
 *
 * - `leases.json` — `{feature: {slot, workspace}}`. A slot is held from the
 *   moment it is allocated, not from when containers first carry its label, so
 *   back-to-back creates can't share one (SW-166) and the gate never moves one
 *   (SW-169). Written only by `slots.ts`, under the `allocate` lock.
 * - `queue.json` — features waiting for capacity, first come first served,
 *   under the `scheduler` lock.
 *
 * What is running, and what it costs, is never stored: `lifecycle.ts` reads it
 * from Docker on every decision, because `up` exits once containers start.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as YAML from "yaml";

import {
  clearWaiting,
  readWaiting,
  waitingPath,
  writeAtomic,
  writeWaiting,
} from "./agent_state.js";
import { COMPOSE_FILE } from "./compose_file.js";
import { envVar, sandboxHome } from "./config.js";
import { docker } from "./docker.js";
import { SandboxError } from "./errors.js";
import { load as loadGlobalConfig } from "./global_config.js";
import { sandboxLock } from "./locks.js";
import { recordEvent, runTag } from "./metrics.js";
import { info } from "./reporter.js";
import {
  admit,
  type Budget,
  type Cost,
  type Decision,
  type Lease,
  parseSize,
  type Waiter,
} from "./scheduler.js";
import { dockerBin } from "./tool_bins.js";

export interface SlotLease {
  slot: number;
  /** "" when backfilled from a label with no workspace folder found. */
  workspace: string;
}

const LOCK_TIMEOUT = 30.0;

// Beside config.yaml, so it relocates with WERKMEISTER_CONFIG_FILE as the rest of the home does.
const stateDir = () => path.join(sandboxHome(), "scheduler");
export const leasesPath = () => path.join(stateDir(), "leases.json");
export const queuePath = () => path.join(stateDir(), "queue.json");
/** Admitted starts whose containers may not run yet: feature → cost and when (SW-907). */
export const startingPath = () => path.join(stateDir(), "starting.json");

// shortcut: a start that fails after admit holds its reservation this long (only a success dequeues);
// drop it on each failure path if that stalls the queue.
const RESERVED_MS = 10 * 60_000;

function readJson<T>(file: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, body);
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Raw leases; callers hold the `allocate` lock. Malformed entries are dropped. */
export function readLeases(): Record<string, SlotLease> {
  const raw = readJson(leasesPath(), isDict, {});
  const out: Record<string, SlotLease> = {};
  for (const [f, v] of Object.entries(raw)) {
    if (isDict(v) && Number.isInteger(v["slot"])) {
      out[f] = { slot: v["slot"] as number, workspace: String(v["workspace"] ?? "") };
    }
  }
  return out;
}

export function writeLeases(leases: Record<string, SlotLease>): void {
  writeJson(leasesPath(), leases);
}

export function readQueue(): string[] {
  return readJson(queuePath(), (v): v is string[] => Array.isArray(v), []).map(String);
}

function writeQueue(q: string[]): void {
  writeJson(queuePath(), q);
}

type Reserved = Record<string, { cost: Cost; at: number }>;

function readReserved(): Reserved {
  return readJson(startingPath(), isDict, {}) as Reserved;
}

/**
 * Admitted starts other than *feature*'s whose containers don't run yet, as leases: admission priced
 * only running containers, so two admits before either one's existed both fit the same room (SW-907).
 */
export function reservedLeases(running: Lease[], feature: string, now = Date.now()): Lease[] {
  return Object.entries(readReserved())
    .filter(
      ([f, r]) =>
        f !== feature &&
        now - r.at < RESERVED_MS &&
        Number.isFinite(r.cost?.cpus) &&
        !running.some((l) => l.feature === f),
    )
    .map(([f, r]) => ({ feature: f, cost: r.cost, rank: "person", busy: true }));
}

/** Drop *feature* from the waiting queue, and its admit reservation: its start settled. */
export function dequeue(feature: string): Promise<void> {
  return sandboxLock(
    "scheduler",
    async () => {
      writeQueue(readQueue().filter((f) => f !== feature));
      const reserved = readReserved();
      if (feature in reserved) {
        delete reserved[feature];
        writeJson(startingPath(), reserved);
      }
    },
    { timeout: LOCK_TIMEOUT },
  );
}

/** Queue a preempted *feature* first and hold its session: it was admitted before every waiter now (SW-1039). */
export function enqueue(feature: string, workspace: string): Promise<void> {
  return sandboxLock(
    "scheduler",
    async () => {
      const queue = readQueue().filter((f) => f !== feature);
      // waiting.json first: if it can't be written, the queue must not move (SW-246).
      writeWaiting(workspace, {
        position: 1,
        reason: "preempted",
        since: new Date().toISOString(),
      });
      writeQueue([feature, ...queue]);
      // Every writer that queues a feature is an event, so a stale waiting.json names its writer (SW-991).
      recordEvent({
        event: "queue.wait",
        workspace: path.basename(workspace),
        feature,
        position: 1,
        reason: "preempted",
        ...runTag(workspace),
      });
    },
    { timeout: LOCK_TIMEOUT },
  );
}

/** Put *feature* back at the head as a capacity waiter; returns its position, 1. */
export function requeueFirst(
  feature: string,
  workspace: string,
  starting?: Starting,
): Promise<number> {
  return sandboxLock(
    "scheduler",
    async () => {
      writeWaiting(workspace, {
        position: 1,
        reason: "waiting for capacity",
        ...starting,
        since: new Date().toISOString(),
      });
      writeQueue([feature, ...readQueue().filter((f) => f !== feature)]);
      recordEvent({
        event: "queue.wait",
        workspace: path.basename(workspace),
        feature,
        position: 1,
        reason: "requeued",
        ...runTag(workspace),
      });
      return 1;
    },
    { timeout: LOCK_TIMEOUT },
  );
}

/**
 * The budget: `budget:` in `~/.werkmeister/config.yaml` over defaults from the
 * engine (memory minus 1G for the VM itself). CPUs have no default limit: a CPU
 * limit is a cap, not use, so summing them queued workspaces on an idle VM, and
 * measured load gates the CPU-heavy steps instead (a setup start, with-temp-home;
 * SW-992). `budget.cpus` still caps the sum. An engine that can't be read and no
 * configured value means no limit: the `compose up` after it fails on its own.
 */
export async function loadBudget(
  info: () => Promise<{ MemTotal?: number }> = () => docker().info(),
): Promise<Budget> {
  const cfg = loadGlobalConfig()["budget"];
  const b = isDict(cfg) ? cfg : {};
  let engine: { MemTotal?: number } = {};
  if (b["memory"] === undefined) {
    try {
      engine = await info();
    } catch {
      // unreachable engine: fall through to Infinity
    }
  }
  const memory =
    b["memory"] !== undefined
      ? parseSize(b["memory"] as string | number)
      : engine.MemTotal
        ? engine.MemTotal - 2 ** 30
        : Infinity;
  const cpus = b["cpus"] !== undefined ? Number(b["cpus"]) : Infinity;
  return { memory, cpus, preempt: b["preempt"] !== false };
}

/** 1-min host load (on macOS and Windows, of the Docker VM) above which with-temp-home and a setup start wait (SW-209, SW-542, SW-630, SW-888): `budget.host_load`, else 2 × cores; 0 is off. */
export function hostLoadLimit(cores: number): number {
  const cfg = loadGlobalConfig()["budget"];
  const v = isDict(cfg) ? Number(cfg["host_load"] ?? Number.NaN) : Number.NaN;
  return Number.isFinite(v) && v >= 0 ? v : 2 * cores;
}

/** % of memory available under which the gate and with-temp-home hold off (SW-620): `budget.free_memory`, else 15; 0 is off. */
export function freeMemoryLimit(): number {
  const cfg = loadGlobalConfig()["budget"];
  const v = isDict(cfg) ? Number(cfg["free_memory"] ?? Number.NaN) : Number.NaN;
  return Number.isFinite(v) && v >= 0 ? v : 15;
}

/**
 * Bytes available and total. On macOS os.freemem() counts only untouched pages (0.08 of 16 GiB on a
 * healthy host), so it reads kern.memorystatus_level, the % the kernel calls available (SW-620).
 */
export function readHostMemory(platform: NodeJS.Platform = process.platform) {
  const total = os.totalmem();
  if (platform !== "darwin") return { free: os.freemem(), total };
  const level = Number(
    execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8" }),
  );
  return { free: (total * level) / 100, total };
}

/** "N% free, under budget.free_memory M%" when memory is low, else ""; unreadable memory is not low. */
export function lowMemory(
  hostMemory: () => { free: number; total: number } = readHostMemory,
): string {
  const limit = freeMemoryLimit();
  if (limit === 0) return "";
  let pct: number;
  try {
    const { free, total } = hostMemory();
    pct = (100 * free) / total;
  } catch {
    return "";
  }
  return Number.isFinite(pct) && pct < limit
    ? `${pct.toFixed(0)}% free, under budget.free_memory ${limit}%`
    : "";
}

const LOAD_POLL_MS = 15_000;
// with-temp-home's own wait: under an agent's default 2 min Bash timeout, so the call can't time out before its command starts (SW-469).
const WRAPPER_LOAD_WAIT_MS = 90_000;
const LOAD_PROGRESS_MS = 60_000;

export interface HostLoadDeps {
  hostLoad: () => { load: number[]; cores: number };
  /** The Docker VM's 1/5/15 min load and cores, read on macOS and Windows in place of hostLoad (SW-888); null when unreadable. */
  vmLoad: () => Promise<{ load: number[]; cores: number } | null>;
  hostMemory: () => { free: number; total: number };
  sleep: (ms: number) => Promise<unknown>;
}

export const readHostLoad = () => ({ load: os.loadavg(), cores: os.availableParallelism() });

// 7 reads × 4 s on top of with-temp-home's 90 s stays under an agent's 2 min Bash timeout (SW-469).
const VM_LOAD_TIMEOUT_MS = 4_000;

/** Marks the probe's container as werkmeister's, so `machine clean` can sweep one a killed run left (SW-969). */
const VM_LOAD_LABEL = "com.werkmeister.role=vm-load";

/**
 * The load probes left Created or exited: `docker run` is create then start, and `--rm` removes
 * only a container that ran, so the 4 s cap can kill it in between (SW-969). Removes them unless
 * *dryRun*; returns their ids, or none when Docker can't be read.
 */
export function sweepVmLoadProbes(dryRun = false): string[] {
  try {
    const ids = execFileSync(
      dockerBin(),
      [
        "ps",
        "-aq",
        "--filter",
        `label=${VM_LOAD_LABEL}`,
        "--filter",
        "status=created",
        "--filter",
        "status=exited",
      ],
      { encoding: "utf8", timeout: 20_000 },
    )
      .split("\n")
      .filter(Boolean);
    if (ids.length && !dryRun)
      execFileSync(dockerBin(), ["rm", ...ids], { timeout: 20_000, stdio: "ignore" });
    return ids;
  } catch {
    return [];
  }
}

/** A container's /proc/loadavg is the VM kernel's, not namespaced; macOS's own loadavg never sees the VM (SW-556, SW-888). */
export function readVmLoad(): Promise<{ load: number[]; cores: number } | null> {
  return new Promise((resolve) => {
    execFile(
      dockerBin(),
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--label",
        VM_LOAD_LABEL,
        "alpine:3",
        "sh",
        "-c",
        "cat /proc/loadavg; nproc",
      ],
      { timeout: VM_LOAD_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => {
        const [avg = "", nproc = ""] = err ? [] : stdout.split("\n");
        const load = avg.split(" ").slice(0, 3).map(Number);
        const cores = Number(nproc);
        const ok = load.length === 3 && [...load, cores].every(Number.isFinite) && cores > 0;
        resolve(ok ? { load, cores } : null);
      },
    );
  });
}

const realHostLoad: HostLoadDeps = {
  hostLoad: readHostLoad,
  vmLoad: readVmLoad,
  hostMemory: readHostMemory,
  sleep: (ms) => delay(ms),
};

/** The 1-min load and its limit: the Docker VM's on macOS and Windows (whose loadavg is always 0), the host's elsewhere; unreadable is limit 0 (not busy). */
async function loadNow(deps: HostLoadDeps, platform: NodeJS.Platform) {
  const vm = platform === "darwin" || platform === "win32";
  const r = vm ? await deps.vmLoad() : deps.hostLoad();
  return r ? { load: r.load[0], limit: hostLoadLimit(r.cores) } : { load: 0, limit: 0 };
}

/** What with-temp-home's wait did: *spent* means a limit was still over when it gave up (SW-716). */
export interface HostLoadWait {
  spent: boolean;
  note: string;
}

const minutes = (ms: number) => Number((ms / 60_000).toFixed(1));

/**
 * The wait of `werkmeister internal wait-load`, which the generated with-temp-home runs first (SW-224):
 * up to 90 s for the 1-minute load to fall under the limit and free memory to rise over its own (SW-620),
 * saying so up front and printing progress each minute (SW-262). Returns the note for the wrapper's stderr ("" when
 * it did not wait) and whether the wait is *spent* with a limit still over (SW-716).
 * The gate stopped waiting in SW-542.
 * On macOS and Windows the load is the Docker VM's (`readVmLoad`): macOS's own loadavg counts idle daemons
 * and never the VM, and Windows' is always 0 (SW-556, SW-888). Memory is the host's: Claude Code
 * stops an idle background shell when the Mac runs low (SW-620).
 */
export async function waitForHostLoadNow(
  deps: HostLoadDeps = realHostLoad,
  platform: NodeJS.Platform = process.platform,
  before = "with-temp-home; --no-wait skips",
): Promise<HostLoadWait> {
  // WERKMEISTER_NO_WAIT skips it inside the command too, not only in with-temp-home's shell (SW-425).
  const none: HostLoadWait = { spent: false, note: "" };
  if (envVar("NO_WAIT")) return none;
  const read = async () => {
    const { load, limit } = await loadNow(deps, platform);
    return {
      load,
      limit,
      loadOver: limit !== 0 && load > limit,
      memory: lowMemory(deps.hostMemory),
    };
  };
  let now = await read();
  if (!now.loadOver && !now.memory) return none;
  const waitedFor = [now.loadOver && "host load", now.memory && "free memory"]
    .filter(Boolean)
    .join(" and ");
  info(
    `waiting up to ${minutes(WRAPPER_LOAD_WAIT_MS)} min for ${[
      now.loadOver && `host load ${now.load.toFixed(1)} to fall to ${now.limit} (budget.host_load)`,
      now.memory && `free memory to rise (${now.memory})`,
    ]
      .filter(Boolean)
      .join(" and ")} before ${before}`,
  );
  const state = () =>
    [
      now.loadOver && `host load ${now.load.toFixed(1)} over ${now.limit}`,
      now.memory && `low memory (${now.memory})`,
    ]
      .filter(Boolean)
      .join(", ");
  for (let waited = LOAD_POLL_MS; waited <= WRAPPER_LOAD_WAIT_MS; waited += LOAD_POLL_MS) {
    await deps.sleep(LOAD_POLL_MS);
    now = await read();
    if (!now.loadOver && !now.memory)
      return { spent: false, note: `waited ${waited / 1000} s for ${waitedFor}` };
    if (waited % LOAD_PROGRESS_MS === 0 && waited < WRAPPER_LOAD_WAIT_MS)
      info(
        `still waiting: ${state()}, ${waited / 1000} s so far, up to ${minutes(WRAPPER_LOAD_WAIT_MS - waited)} min left`,
      );
  }
  return {
    spent: true,
    note: `ran with ${state()}; the ${minutes(WRAPPER_LOAD_WAIT_MS)} min host-load wait is spent`,
  };
}

/**
 * Before compose starts a setup one-shot among *services* (undefined: what a whole `up` starts),
 * wait on host load and free memory as with-temp-home does, and fail once the wait is spent (SW-630,
 * SW-620): a setup install started at load ~413 ran 78 min, past compose's 20 min `--wait`, and ended 137.
 *
 * Throws `HOST_LOAD`.
 */
export async function waitForSetupLoad(
  workspace: string,
  services: string[] | undefined,
  deps: HostLoadDeps = realHostLoad,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const setups = Object.entries(composeServices(workspace))
    .filter(([name, svc]) => (services ? services.includes(name) : !svc?.["profiles"]))
    .filter(([, svc]) => svc?.["labels"]?.["com.werkmeister.role"] === "setup")
    .map(([name]) => name);
  if (!setups.length) return;
  const what = setups.join(", ");
  const { spent, note } = await waitForHostLoadNow(
    deps,
    platform,
    `starting ${what}; WERKMEISTER_NO_WAIT=1 skips`,
  );
  if (!spent) return;
  const { load, limit } = await loadNow(deps, platform);
  const memory = lowMemory(deps.hostMemory);
  const over = [
    limit !== 0 &&
      load > limit &&
      `host load ${load.toFixed(1)} is over ${limit} (budget.host_load)`,
    memory && `memory is low (${memory})`,
  ]
    .filter(Boolean)
    .join(" and ");
  throw new SandboxError(
    `${over || note} after the ${minutes(WRAPPER_LOAD_WAIT_MS)} min wait; ${what} not started. ` +
      "Retry when load falls or memory frees, or set WERKMEISTER_NO_WAIT=1 to start anyway.",
    "HOST_LOAD",
  );
}

type ComposeService = Record<string, any>;

function composeServices(
  workspace: string,
  composePath = path.join(workspace, COMPOSE_FILE),
): Record<string, ComposeService> {
  try {
    const doc = YAML.parse(fs.readFileSync(composePath, "utf8"));
    return isDict(doc?.services) ? (doc.services as Record<string, ComposeService>) : {};
  } catch {
    return {};
  }
}

/**
 * What starting *services* costs, or with none what `up` will start (services
 * behind a profile, `on-demand`, don't start on `up`): the same numbers Docker gets.
 */
export function featureCost(workspace: string, services?: string[]): Cost {
  const cost = { memory: 0, cpus: 0 };
  for (const [name, svc] of Object.entries(composeServices(workspace))) {
    if (!isDict(svc) || (services ? !services.includes(name) : svc["profiles"])) continue;
    // A current install only checks its stamp and exits; pricing its build CPUs held 5-CPU waiters for 3-CPU sets (SW-992).
    if (installStamped(svc)) continue;
    const res = (svc as ComposeService)["deploy"]?.["resources"];
    const mem = res?.["reservations"]?.["memory"];
    if (mem !== undefined) cost.memory += parseSize(mem);
    cost.cpus += Number(res?.["limits"]?.["cpus"] ?? 0) || 0;
  }
  return cost;
}

/** The services a plain `up` starts: those behind no profile. */
export function upServices(workspace: string): string[] {
  return Object.entries(composeServices(workspace))
    .filter(([, svc]) => isDict(svc) && !svc["profiles"])
    .map(([name]) => name);
}

const dependsOn = (svc: ComposeService | undefined): string[] => {
  const deps = svc?.["depends_on"];
  return Array.isArray(deps) ? deps.map(String) : isDict(deps) ? Object.keys(deps) : [];
};

/** *service* and what compose starts with it (its `depends_on`, the install among them). */
export function serviceStarts(workspace: string, service: string): string[] {
  return [service, ...dependsOn(composeServices(workspace)[service])];
}

/**
 * Whether every `depends_on` of *service* is a setup one-shot whose install already
 * succeeded for the current lockfile and Node major (SW-541), so `up --no-deps` may
 * skip it: compose re-runs an exited one-shot on every `up <svc>`, and that re-ran
 * the whole build at 2 CPUs after each edit. A runtime dep (a database) keeps deps.
 */
export async function setupsCurrent(composePath: string, service: string): Promise<boolean> {
  const services = composeServices(path.dirname(composePath), composePath);
  const deps = dependsOn(services[service]);
  if (!deps.length || !deps.every((d) => installStamped(services[d]))) return false;
  for (const d of deps) {
    // The stamp is in the worktree; node_modules is a volume `down -v` removes with the
    // container, and a build that fails after the stamp leaves a non-zero exit.
    const name = services[d]?.["container_name"];
    const state = name
      ? await docker()
          .getContainer(String(name))
          .inspect()
          .then(
            (c) => c.State,
            () => null,
          )
      : null;
    if (state?.Status !== "exited" || state.ExitCode !== 0) return false;
  }
  return true;
}

/** The worktree stamp startup.sh writes after a successful install (SW-33, SW-85) matches now. */
function installStamped(svc: ComposeService | undefined): boolean {
  if (svc?.["labels"]?.["com.werkmeister.role"] !== "setup") return false;
  const major = /^node:(\d+)/.exec(String(svc["image"] ?? ""))?.[1];
  const mount = (svc["volumes"] ?? []).map(String).find((v: string) => v.endsWith(":/app"));
  if (!major || !mount) return false;
  const wt = mount.slice(0, -":/app".length);
  // `cat package-lock.json pnpm-lock.yaml | sha256sum`, then `node -v | cut -d. -f1`.
  const lock = Buffer.concat(
    ["package-lock.json", "pnpm-lock.yaml"].flatMap((f) => {
      try {
        return [fs.readFileSync(path.join(wt, f))];
      } catch {
        return [];
      }
    }),
  );
  const want = `${createHash("sha256").update(lock).digest("hex")} v${major}`;
  try {
    return (
      fs.readFileSync(path.join(wt, ".turbo/.werkmeister-install-hash"), "utf8").trim() === want
    );
  } catch {
    return false;
  }
}

/** A start of named services, held by the process polling for it (SW-540). */
export interface Starting {
  services: string[];
  /** Released its own running containers to wait for them and these together (SW-675). */
  gate?: true;
}

/** Four of the start's 15 s polls, each of which rewrites its waiting.json. */
const WAITER_STALE_MS = 60_000;

/**
 * *queue* without service waiters whose poll stopped (a killed gate); their waiting.json goes too.
 * By the file's age, not a pid: a reused pid would look alive and hold the queue head forever.
 */
function withoutDeadWaiters(queue: string[]): string[] {
  const leases = readLeases();
  return queue.filter((f) => {
    const ws = leases[f]?.workspace;
    // Every queue write puts waiting.json first (SW-246), so a waiter without one was cleared over its
    // running containers (the hook, SW-986): it would hold the head for a feature that already runs.
    if (ws && !fs.existsSync(waitingPath(ws))) return false;
    const w = ws ? readWaiting(ws) : null;
    if (!ws || !w?.services || w.parked) return true; // a parked start has no poll by design (SW-701)
    const at = fs.statSync(waitingPath(ws), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (Date.now() - at < WAITER_STALE_MS) return true;
    clearWaiting(ws);
    return false;
  });
}

/** *queue* as admission sees it: each waiter's wait so far and whether it is a gate (SW-675). */
export function waiters(queue: string[], running: Lease[], now = Date.now()): Waiter[] {
  const leases = readLeases();
  return queue.map((feature) => {
    const ws = leases[feature]?.workspace;
    const w = ws ? readWaiting(ws) : null;
    const since = w?.since ? Date.parse(w.since) : Number.NaN;
    if (ws && w?.parked) {
      // Started only by a grant, like a whole-feature waiter, so priced like one; never a gate (SW-701).
      return {
        feature,
        waitedMs: Number.isFinite(since) ? Math.max(0, now - since) : 0,
        gate: false,
        parked: true,
        cost: featureCost(ws, w.services),
      };
    }
    return {
      feature,
      waitedMs: Number.isFinite(since) ? Math.max(0, now - since) : 0,
      gate: !!w?.gate || (!!w?.services && running.some((l) => l.feature === feature)),
      ...(ws && !w?.services && { cost: featureCost(ws) }),
    };
  });
}

/**
 * Queue-or-admit *req* against *running*. On wait it joins the queue and gets
 * `waiting.json`; on admit it leaves both. The caller stops any victims.
 * *starting* prices just those services, on top of what the feature already runs.
 */
export function requestAdmission(
  feature: string,
  workspace: string,
  byPerson: boolean,
  running: Lease[],
  budget: Budget,
  starting?: Starting,
  /** The grant pass: throw `NOT_QUEUED` rather than admit a feature that left the queue (SW-1110). */
  fromQueue?: boolean,
): Promise<Decision> {
  const cost = featureCost(workspace, starting?.services);
  // Starts nothing (a plain `up` of an all-on-demand workspace): no room to wait for, and its
  // gate may hold this feature's place in the queue, which an admit here would drop.
  if (!cost.memory && !cost.cpus) return Promise.resolve({ kind: "admit" });
  return sandboxLock(
    "scheduler",
    async () => {
      const stored = readQueue();
      const queue = withoutDeadWaiters(stored);
      if (fromQueue && !queue.includes(feature)) {
        // The prune is written below on every other path; a dead waiter here would be re-granted each pass.
        if (queue.length !== stored.length) writeQueue(queue);
        throw new SandboxError(
          `'${feature}' left the waiting queue before its grant`,
          "NOT_QUEUED",
        );
      }
      const held = [...running, ...reservedLeases(running, feature)];
      const own = starting ? undefined : running.find((l) => l.feature === feature);
      // What runs may be an on-demand service `up` doesn't start: price the `up` services not running (SW-907).
      const added = own?.services
        ? featureCost(
            workspace,
            upServices(workspace).filter((s) => !own.services?.includes(s)),
          )
        : undefined;
      const d = admit(budget, held, waiters(queue, held), {
        feature,
        cost,
        byPerson,
        services: starting?.services,
        ...(starting?.gate && { gate: true }),
        ...(added && { added }),
      });
      let next = queue;
      const admitted = d.kind === "admit" || d.kind === "preempt";
      // A whole `up` of a feature that runs keeps its containers when it waits: queued, the hook would
      // hold its session over them (SW-909). It leaves the queue, as an admit does; the caller reruns.
      if (admitted && !running.some((l) => l.feature === feature))
        writeJson(startingPath(), { ...readReserved(), [feature]: { cost, at: Date.now() } });
      // A queued feature re-asks on every poll: only the first wait and the admit that ends it are events (SW-775).
      const prev = readWaiting(workspace);
      const name = path.basename(workspace);
      if (d.kind === "wait" && !own) {
        // waiting.json first: if it can't be written, the queue must not move (SW-246).
        writeWaiting(workspace, {
          position: d.position,
          reason: "waiting for capacity",
          ...starting,
          since: prev?.since ?? new Date().toISOString(),
        });
        if (!prev)
          recordEvent({
            event: "queue.wait",
            workspace: name,
            feature,
            position: d.position,
            reason: "waiting for capacity",
            ...runTag(workspace),
          });
        if (!queue.includes(feature)) next = [...queue, feature];
      } else {
        next = queue.filter((f) => f !== feature);
        clearWaiting(workspace);
        if (prev && admitted) {
          const waited = Math.round((Date.now() - Date.parse(prev.since ?? "")) / 1000);
          const waited_s = Number.isNaN(waited) ? 0 : Math.max(0, waited);
          recordEvent({
            event: "queue.admit",
            workspace: name,
            feature,
            waited_s,
            ...runTag(workspace),
          });
        }
      }
      if (next.join("\n") !== stored.join("\n")) writeQueue(next);
      return d;
    },
    { timeout: LOCK_TIMEOUT },
  );
}

/** Host ports *workspace*'s compose publishes for services that start on `up`. */
function publishedPorts(workspace: string, services?: string[]): number[] {
  const ports: number[] = [];
  for (const [name, svc] of Object.entries(composeServices(workspace))) {
    if (!isDict(svc) || (services ? !services.includes(name) : svc["profiles"])) continue;
    for (const p of (svc as ComposeService)["ports"] ?? []) {
      const host = Number.parseInt(String(p).split(":").slice(-2)[0] ?? "", 10);
      if (Number.isInteger(host)) ports.push(host);
    }
  }
  return ports;
}

function bound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE"));
    srv.listen(port, "0.0.0.0", () => srv.close(() => resolve(false)));
  });
}

/**
 * Host ports *feature* is about to publish that something else already binds
 * (SW-173). *services* narrows to those the caller will start (default: the
 * ones `up` starts). A port this feature's own container publishes is fine.
 */
export async function portHolders(
  feature: string,
  workspace: string,
  services?: string[],
): Promise<{ port: number; holder: string }[]> {
  const publishers = new Map<number, { name: string; feature: string }>();
  try {
    for (const c of await docker().listContainers()) {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const owner = c.Labels?.["com.werkmeister.feature"] ?? "";
      for (const p of c.Ports ?? []) {
        if (p.PublicPort) publishers.set(p.PublicPort, { name, feature: owner });
      }
    }
  } catch {
    // no daemon: the probe below still finds the clash, just without a name
  }
  const clashes: { port: number; holder: string }[] = [];
  for (const port of publishedPorts(workspace, services)) {
    const pub = publishers.get(port);
    if (pub?.feature === feature) continue;
    if (pub || (await bound(port))) clashes.push({ port, holder: pub?.name ?? "a host process" });
  }
  return clashes;
}
