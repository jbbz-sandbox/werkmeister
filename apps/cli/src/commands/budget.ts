/**
 * werkmeister budget status [--json]
 *
 * The scheduler's budget (proposal 3, SW-181), the features holding a slot, what
 * each running one holds, and what each waiter needs, in admission order (SW-675).
 * The read itself is werkmeister-core's `budgetStatus`, shared with the `budget` tool.
 */

import { budgetStatus, type hostLoads, type LoadReading } from "werkmeister-core/budget_status";
import { describeLease } from "werkmeister-core/lifecycle";

const GIB = 2 ** 30;
const limit = (n: number, unit: string) =>
  Number.isFinite(n) ? `${Number(n.toFixed(1))}${unit}` : "no limit";

/** Each load *reading* beside its *limit*, so neither reads as the other (SW-728, SW-1236); macOS and Windows read the Docker VM (SW-888). */
export function hostLoadText(
  { vm, mac }: Awaited<ReturnType<typeof hostLoads>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const one = (name: string, r: LoadReading) =>
    `${name} load ${r.load === null ? "unknown" : Number(r.load.toFixed(1))} (limit ${r.limit || "off"})`;
  const parts = [one(platform === "linux" ? "host" : "Docker VM", vm)];
  if (mac) parts.push(one("Mac", mac));
  return parts.join(", ");
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const { budget, hostLoad, leases, running, order, json } = await budgetStatus();
  if (args.json) {
    console.log(JSON.stringify(json));
    return;
  }

  console.log(
    `Budget: ${limit(budget.memory / GIB, " GiB")} memory, ${limit(budget.cpus, " CPUs")}, ` +
      `${hostLoadText(hostLoad)}, preemption ${budget.preempt ? "on" : "off"}`,
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
      ? `  waited ${Math.round(w.waitedMs / 60_000)} min${w.holds ? ", gets the next free room" : ""}`
      : "";
    console.log(`  ${w.position}. ${w.feature}  ${what}${need}${waited}`);
  }
}
