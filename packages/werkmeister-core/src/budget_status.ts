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
  loadBudget,
  readLeases,
  readVmLoad,
  waiters,
} from "./scheduler_state.js";

let cores: Promise<number | undefined> | undefined;

/**
 * The Docker VM's core count, read once per process: `readVmLoad` runs a container, and the pane polls
 * the `budget` tool every 30 s (SW-1028). A failed read is not kept, so the next call tries again.
 * shortcut: a VM resized while the daemon runs keeps its old count until the daemon restarts.
 */
export function vmCores(): Promise<number | undefined> {
  cores ??= readVmLoad().then((r) => {
    if (!r) cores = undefined;
    return r?.cores;
  });
  return cores;
}

export async function budgetStatus() {
  const budget = await loadBudget();
  // macOS and Windows scale the limit by the Docker VM's cores, as the wait does (SW-888).
  const vm = process.platform === "darwin" || process.platform === "win32";
  const hostLoad = hostLoadLimit((vm && (await vmCores())) || os.availableParallelism());
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
