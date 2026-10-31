/**
 * werkmeister budget status [--json]
 *
 * The scheduler's budget (proposal 3, SW-181), the features holding a slot and
 * the features Waiting for room, first come first served.
 */

import os from "node:os";
import { waitingQueue } from "werkmeister-core/scheduler_client";
import { hostLoadLimit, loadBudget, readLeases } from "werkmeister-core/scheduler_state";

const GIB = 2 ** 30;
const limit = (n: number, unit: string) =>
  Number.isFinite(n) ? `${Number(n.toFixed(1))}${unit}` : "no limit";

export async function run(args: Record<string, unknown>): Promise<void> {
  const budget = await loadBudget();
  const hostLoad = hostLoadLimit(os.cpus().length);
  // A snapshot for display: no `allocate` lock, so a lease taken mid-read shows next time.
  const leases = readLeases();
  const waiting = await waitingQueue();

  if (args.json) {
    // JSON has no Infinity: an unlimited value is null.
    const n = (v: number) => (Number.isFinite(v) ? v : null);
    console.log(
      JSON.stringify({
        budget: { memory: n(budget.memory), cpus: n(budget.cpus), preempt: budget.preempt },
        host_load: hostLoad,
        leases,
        waiting,
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
  console.log(waiting.length ? "Waiting:" : "Waiting: none");
  for (const [i, feature] of waiting.entries()) console.log(`  ${i + 1}. ${feature}`);
}
