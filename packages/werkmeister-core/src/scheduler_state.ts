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

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import * as YAML from "yaml";

import { clearWaiting, writeAtomic, writeWaiting } from "./agent_state.js";
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
      writeQueue([...queue, feature]);
      writeWaiting(workspace, { position: queue.length + 1, reason: "preempted" });
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

type ComposeService = Record<string, any>;

function composeServices(workspace: string): Record<string, ComposeService> {
  try {
    const doc = YAML.parse(fs.readFileSync(path.join(workspace, COMPOSE_FILE), "utf8"));
    return isDict(doc?.services) ? (doc.services as Record<string, ComposeService>) : {};
  } catch {
    return {};
  }
}

/**
 * What `up` will start, from the workspace's compose file: the same numbers
 * Docker gets. Services behind a profile (`on-demand`) don't start on `up`.
 */
export function featureCost(workspace: string): Cost {
  const cost = { memory: 0, cpus: 0 };
  for (const svc of Object.values(composeServices(workspace))) {
    if (!isDict(svc) || svc["profiles"]) continue;
    const res = (svc as ComposeService)["deploy"]?.["resources"];
    const mem = res?.["reservations"]?.["memory"];
    if (mem !== undefined) cost.memory += parseSize(mem);
    cost.cpus += Number(res?.["limits"]?.["cpus"] ?? 0) || 0;
  }
  return cost;
}

/**
 * Queue-or-admit *req* against *running*. On wait it joins the queue and gets
 * `waiting.json`; on admit it leaves both. The caller stops any victims.
 */
export function requestAdmission(
  feature: string,
  workspace: string,
  byPerson: boolean,
  running: Lease[],
  budget: Budget,
): Promise<Decision> {
  const cost = featureCost(workspace);
  return sandboxLock(
    "scheduler",
    async () => {
      const queue = readQueue();
      const d = admit(budget, running, queue, { feature, cost, byPerson });
      if (d.kind === "wait") {
        if (!queue.includes(feature)) writeQueue([...queue, feature]);
        writeWaiting(workspace, { position: d.position, reason: "waiting for capacity" });
      } else {
        if (queue.includes(feature)) writeQueue(queue.filter((f) => f !== feature));
        clearWaiting(workspace);
      }
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
