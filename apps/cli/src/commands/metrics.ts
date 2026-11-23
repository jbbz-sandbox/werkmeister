/**
 * werkmeister metrics rebuild
 *
 * Backfill ~/.werkmeister/metrics from record branches, GitHub and transcripts (SW-780).
 */

import { rebuildMetrics } from "werkmeister-core/metrics_rebuild";
import { error, success } from "../lib/config.js";

/** Execute the ``werkmeister metrics rebuild`` command. */
export async function run(): Promise<void> {
  try {
    const { added, total, usages } = await rebuildMetrics();
    const counts = Object.entries(added)
      .map(([event, n]) => `${event} ${n}`)
      .join(", ");
    success(`metrics rebuild: ${total} added (${counts}), ${usages} usage snapshots`);
  } catch (e) {
    error(`metrics rebuild: ${(e as Error).message}`);
    process.exit(1);
  }
}
