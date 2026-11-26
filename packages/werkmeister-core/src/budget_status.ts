/**
 * The scheduler's budget, the features holding a slot, what each running one holds, and what
 * each waiter needs, in admission order (SW-675): one read for `werkmeister budget status` and
 * the daemon's `budget` tool (SW-1006), so the two never disagree.
 */

import os from "node:os";
import { readWaiting } from "./agent_state.js";
import { runningLeases } from "./lifecycle.js";
import { headCanWaitOut, queueOrder, STARVE_MS } from "./scheduler.js";
import { waitingQueue } from "./scheduler_client.js";
import {
  featureCost,
  hostLoadLimit,
  hostLoadMacLimit,
  loadBudget,
  readLeases,
  readVmLoad,
  waiters,
} from "./scheduler_state.js";

const VM_READ_MS = 60_000;
let vmRead: { at: number; read: Promise<{ load: number[]; cores: number } | null> } | undefined;
let vmCores: number | undefined;

/**
 * The Docker VM's load and cores, read at most once a minute: `readVmLoad` runs a container, and the pane
 * polls the `budget` tool every 30 s (SW-1028). A failed read keeps the last good core count.
 */
function vmReading(): Promise<{ load: number[]; cores: number } | null> {
  if (!vmRead || Date.now() - vmRead.at > VM_READ_MS)
    vmRead = {
      at: Date.now(),
      read: readVmLoad().then((r) => {
        if (r) vmCores = r.cores;
        return r;
      }),
    };
  return vmRead.read;
}

/** A 1-min load reading (null: unreadable) beside its limit (0: off). */
export interface LoadReading {
  load: number | null;
  limit: number;
}

/**
 * The limits and the loads they gate (SW-1236): *vm* is the Docker VM's (the host's on Linux), which
 * with-temp-home and setup starts wait on; *mac* the Mac's own, which admission waits on, null off macOS.
 */
export async function hostLoads(
  platform: NodeJS.Platform = process.platform,
): Promise<{ vm: LoadReading; mac: LoadReading | null }> {
  // macOS and Windows read the Docker VM and scale its limit by the VM's cores, as the wait does (SW-888).
  const inVm = platform === "darwin" || platform === "win32";
  const r = inVm ? await vmReading() : { load: os.loadavg(), cores: os.availableParallelism() };
  const cores = (inVm ? (r?.cores ?? vmCores) : r?.cores) || os.availableParallelism();
  return {
    vm: { load: r ? r.load[0] : null, limit: hostLoadLimit(cores) },
    mac: platform === "darwin" ? { load: os.loadavg()[0], limit: hostLoadMacLimit() } : null,
  };
}

export async function budgetStatus() {
  const budget = await loadBudget();
  const hostLoad = await hostLoads();
  // A snapshot for display: no `allocate` lock, so a lease taken mid-read shows next time.
  const leases = readLeases();
  const waiting = await waitingQueue();
  const running = runningLeases();
  const order = queueOrder(waiters(waiting, running ?? [])).map((w, i) => {
    const ws = leases[w.feature]?.workspace;
    const services = (ws && readWaiting(ws)?.services) || null;
    const cost = ws ? featureCost(ws, services ?? undefined) : null;
    // The head the queue holds for: as admit() and capacityWait have it (SW-701, SW-903).
    const holds =
      i === 0 && w.waitedMs >= STARVE_MS && !w.parked && headCanWaitOut(budget, running ?? [], w);
    return { ...w, position: i + 1, services, cost, holds };
  });

  // JSON has no Infinity: an unlimited value is null.
  const n = (v: number) => (Number.isFinite(v) ? v : null);
  const json = {
    budget: { memory: n(budget.memory), cpus: n(budget.cpus), preempt: budget.preempt },
    host_load: hostLoad,
    leases,
    waiting,
    running:
      running?.map((l) => ({
        feature: l.feature,
        cpus: l.cost.cpus,
        memory: l.cost.memory,
        rank: l.rank,
        busy: l.busy,
      })) ?? null,
    waiters: order.map((w) => ({
      feature: w.feature,
      position: w.position,
      services: w.services,
      cpus: w.cost?.cpus ?? null,
      memory: w.cost?.memory ?? null,
      waited_ms: w.waitedMs,
      gate: w.gate,
    })),
  };
  return { budget, hostLoad, leases, running, order, json };
}
