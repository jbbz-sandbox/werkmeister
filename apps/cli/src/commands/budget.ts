/**
 * werkmeister budget status [--json]
 *
 * The scheduler's budget (proposal 3, SW-181), the features holding a slot, what
 * each running one holds, and what each waiter needs, in admission order (SW-675).
 */

import os from "node:os";
import { readWaiting } from "werkmeister-core/agent_state";
import { describeLease, runningLeases } from "werkmeister-core/lifecycle";
import { queueOrder, STARVE_MS } from "werkmeister-core/scheduler";
import { waitingQueue } from "werkmeister-core/scheduler_client";
import {
  featureCost,
  hostLoadLimit,
  loadBudget,
  readLeases,
  waiters,
} from "werkmeister-core/scheduler_state";

const GIB = 2 ** 30;
const limit = (n: number, unit: string) =>
  Number.isFinite(n) ? `${Number(n.toFixed(1))}${unit}` : "no limit";

export async function run(args: Record<string, unknown>): Promise<void> {
  const budget = await loadBudget();
  const hostLoad = hostLoadLimit(os.cpus().length);
  // A snapshot for display: no `allocate` lock, so a lease taken mid-read shows next time.
  const leases = readLeases();
  const waiting = await waitingQueue();
  const running = runningLeases();
  const order = queueOrder(waiters(waiting, running ?? [])).map((w, i) => {
    const ws = leases[w.feature]?.workspace;
    const services = (ws && readWaiting(ws)?.services) || null;
    const cost = ws ? featureCost(ws, services ?? undefined) : null;
    return { ...w, position: i + 1, services, cost };
  });

  if (args.json) {
    // JSON has no Infinity: an unlimited value is null.
    const n = (v: number) => (Number.isFinite(v) ? v : null);
    console.log(
      JSON.stringify({
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
      }),
    );
    return;
  }

  console.log(
    `Budget: ${limit(budget.memory / GIB, " GiB")} memory, ${limit(budget.cpus, " CPUs")}, ` +
      `host load ${hostLoad || "unchecked"}, preemption ${budget.preempt ? "on" : "off"}`,
  );
  const held = Object.entries(leases).sort(([, a], [, b]) => a.slot - b.slot);
  console.log(held.length ? "Slots:" : "Slots: none held");
  for (const [feature, lease] of held)
    console.log(`  ${lease.slot}  ${feature}${lease.workspace ? `  ${lease.workspace}` : ""}`);
  if (!running) console.log("Running: docker unavailable");
  else console.log(running.length ? "Running:" : "Running: none");
  for (const l of [...(running ?? [])].sort((a, b) => b.cost.cpus - a.cost.cpus))
    console.log(`  ${describeLease(l)}`);
  console.log(order.length ? "Waiting:" : "Waiting: none");
  for (const w of order) {
    const what = w.services
      ? `${w.services.join(", ")}${w.gate ? " for a running feature" : ""}`
      : "whole feature";
    const need = w.cost
      ? ` (${Number(w.cost.cpus.toFixed(1))} CPUs, ${(w.cost.memory / GIB).toFixed(1)} GiB)`
      : "";
    const waited = w.waitedMs
      ? `  waited ${Math.round(w.waitedMs / 60_000)} min${w.position === 1 && w.waitedMs >= STARVE_MS ? ", gets the next free room" : ""}`
      : "";
    console.log(`  ${w.position}. ${w.feature}  ${what}${need}${waited}`);
  }
}
