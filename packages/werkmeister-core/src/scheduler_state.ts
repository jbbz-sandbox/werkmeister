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

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import * as YAML from "yaml";

import {
  clearWaiting,
  readWaiting,
  waitingPath,
  writeAtomic,
  writeWaiting,
} from "./agent_state.js";
import { COMPOSE_FILE } from "./compose_file.js";
import { sandboxHome } from "./config.js";
import { docker } from "./docker.js";
import { load as loadGlobalConfig } from "./global_config.js";
import { sandboxLock } from "./locks.js";
import {
  admit,
  type Budget,
  type Cost,
  type Decision,
  type Lease,
  parseSize,
} from "./scheduler.js";

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

/** Drop *feature* from the waiting queue. */
export function dequeue(feature: string): Promise<void> {
  return sandboxLock(
    "scheduler",
    async () => writeQueue(readQueue().filter((f) => f !== feature)),
    { timeout: LOCK_TIMEOUT },
  );
}

/** Queue *feature* at the back and hold its session (a preempted feature). */
export function enqueue(feature: string, workspace: string): Promise<void> {
  return sandboxLock(
    "scheduler",
    async () => {
      const queue = readQueue().filter((f) => f !== feature);
      // waiting.json first: if it can't be written, the queue must not move (SW-246).
      writeWaiting(workspace, { position: queue.length + 1, reason: "preempted" });
      writeQueue([...queue, feature]);
    },
    { timeout: LOCK_TIMEOUT },
  );
}

/**
 * The budget: `budget:` in `~/.werkmeister/config.yaml` over defaults from the
 * engine (memory minus 1G for the VM itself, every CPU). An engine that can't
 * be read and no configured value means no limit: the `compose up` after it
 * fails on its own.
 */
export async function loadBudget(
  info: () => Promise<{ MemTotal?: number; NCPU?: number }> = () => docker().info(),
): Promise<Budget> {
  const cfg = loadGlobalConfig()["budget"];
  const b = isDict(cfg) ? cfg : {};
  let engine: { MemTotal?: number; NCPU?: number } = {};
  if (b["memory"] === undefined || b["cpus"] === undefined) {
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
  const cpus = b["cpus"] !== undefined ? Number(b["cpus"]) : (engine.NCPU ?? Infinity);
  return { memory, cpus, preempt: b["preempt"] !== false };
}

/** 1-min host load above which the gate waits (SW-209): `budget.host_load`, else 2 × cores; 0 is off. */
export function hostLoadLimit(cores: number): number {
  const cfg = loadGlobalConfig()["budget"];
  const v = isDict(cfg) ? Number(cfg["host_load"] ?? Number.NaN) : Number.NaN;
  return Number.isFinite(v) && v >= 0 ? v : 2 * cores;
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
    const res = (svc as ComposeService)["deploy"]?.["resources"];
    const mem = res?.["reservations"]?.["memory"];
    if (mem !== undefined) cost.memory += parseSize(mem);
    cost.cpus += Number(res?.["limits"]?.["cpus"] ?? 0) || 0;
  }
  return cost;
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
    if (!ws || !readWaiting(ws)?.services) return true;
    const at = fs.statSync(waitingPath(ws), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (Date.now() - at < WAITER_STALE_MS) return true;
    clearWaiting(ws);
    return false;
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
      const d = admit(budget, running, queue, {
        feature,
        cost,
        byPerson,
        services: starting?.services,
      });
      let next = queue;
      if (d.kind === "wait") {
        // waiting.json first: if it can't be written, the queue must not move (SW-246).
        writeWaiting(workspace, {
          position: d.position,
          reason: "waiting for capacity",
          ...starting,
        });
        if (!queue.includes(feature)) next = [...queue, feature];
      } else {
        next = queue.filter((f) => f !== feature);
        clearWaiting(workspace);
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
