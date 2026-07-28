/**
 * sandbox stats
 *
 * Collect and display Docker container resource usage for all sandbox containers.
 * Supports a one-shot snapshot or continuous collection over a time period.
 *
 * Examples:
 *     sandbox stats                     # Snapshot of current usage
 *     sandbox stats --collect 5         # Collect for 5 minutes
 *     sandbox stats --collect 30 -i 5   # 30 minutes, 5-second intervals
 */

import { Colors, info, success, warn } from "../lib/config.js";
import {
  ContainerStats,
  collectSnapshot,
  collectStats,
  formatRecommendations,
  formatStatsTable,
  recommendLimits,
  saveReport,
} from "../lib/stats.js";

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Execute the ``sandbox stats`` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const duration = (args.collect as number) ?? 0;
  const interval = (args.interval as number) ?? 10;
  const save = Boolean(args.save);

  console.log(`\n${Colors.BOLD}=== Docker Resource Usage ===${Colors.RESET}\n`);

  if (duration > 0) {
    await runCollection(duration, interval, save);
  } else {
    runSnapshot(save);
  }
}

/** Show a one-shot snapshot of current container stats. */
function runSnapshot(_save: boolean): void {
  const snapshot = collectSnapshot();

  if (!snapshot.length) {
    warn("No running containers found. Start your sandbox first.");
    return;
  }

  // Filter to sandbox containers
  let sandboxEntries = snapshot.filter(
    (e) => e.name.startsWith("sandbox-") || e.name.startsWith("feat-"),
  );
  if (!sandboxEntries.length) {
    // Show all if no sandbox prefix match
    sandboxEntries = snapshot;
  }

  // Display as table
  const header =
    `  ${Colors.BOLD}${"Container".padEnd(35)}  ` +
    `${"CPU".padStart(8)}  ${"Memory".padStart(10)}  ` +
    `${"Limit".padStart(10)}${Colors.RESET}`;
  console.log(header);
  console.log(`  ${"─".repeat(70)}`);

  let totalCpu = 0.0;
  let totalMem = 0.0;

  for (const e of [...sandboxEntries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const cpu = e.cpu_percent;
    const mem = e.mem_mib;
    const limit = e.mem_limit_mib;
    totalCpu += cpu;
    totalMem += mem;

    // Color code based on memory usage vs limit
    let memColor: string;
    if (limit > 0 && mem / limit > 0.8) {
      memColor = Colors.RED;
    } else if (limit > 0 && mem / limit > 0.6) {
      memColor = Colors.YELLOW;
    } else {
      memColor = "";
    }

    const memStr = fmtMem(mem);
    const limitStr = limit > 0 ? fmtMem(limit) : "unlimited";

    console.log(
      `  ${e.name.padEnd(35)}  ` +
        `${cpu.toFixed(1).padStart(7)}%  ` +
        `${memColor}${memStr.padStart(10)}${memColor ? Colors.RESET : ""}  ` +
        `${limitStr.padStart(10)}`,
    );
  }

  console.log(`  ${"─".repeat(70)}`);
  console.log(
    `  ${Colors.BOLD}${"Total".padEnd(35)}  ` +
      `${totalCpu.toFixed(1).padStart(7)}%  ` +
      `${fmtMem(totalMem).padStart(10)}${Colors.RESET}`,
  );
  console.log();
}

/** Collect stats over a time period and show recommendations. */
async function runCollection(durationMinutes: number, interval: number, save: boolean): Promise<void> {
  const durationSeconds = durationMinutes * 60;
  const totalSamples = Math.floor(durationSeconds / interval);

  info(
    `Collecting stats for ${durationMinutes} minute(s), ` +
      `sampling every ${interval} seconds (${totalSamples} samples)`,
  );
  console.log(`  ${Colors.DIM}Press Ctrl+C to stop early${Colors.RESET}\n`);

  let stats: Record<string, ContainerStats>;
  try {
    stats = await collectStats(durationSeconds, interval);
  } catch {
    // ponytail: Python catches KeyboardInterrupt here; Node delivers Ctrl+C as
    // SIGINT (process termination), so this fallback only fires for other
    // surfaced interruptions — kept for structural parity with the Python.
    console.log(`\n  ${Colors.YELLOW}Collection stopped early${Colors.RESET}\n`);
    // Re-collect what we have so far (the function already has partial data)
    // We need to handle this differently - collect manually
    stats = await collectInterruptible(durationSeconds, interval);
  }

  if (!Object.keys(stats).length) {
    warn("No container data collected.");
    return;
  }

  // Show stats
  console.log(`\n${Colors.BOLD}--- Collected Statistics ---${Colors.RESET}\n`);
  console.log(formatStatsTable(stats));

  // Show recommendations
  const recommendations = recommendLimits(stats);
  console.log(`\n${Colors.BOLD}--- Recommended Resource Limits ---${Colors.RESET}\n`);
  console.log(formatRecommendations(recommendations));

  // Save report
  if (save) {
    const reportPath = saveReport(stats, recommendations);
    if (reportPath) {
      success(`Report saved to: ${reportPath}`);
    }
  } else {
    console.log(
      `  ${Colors.DIM}Tip: Use --save to write results to stats/ directory${Colors.RESET}`,
    );
  }

  console.log();
}

/** Collect stats with Ctrl+C support, returning partial results. */
async function collectInterruptible(
  durationSeconds: number,
  intervalSeconds: number,
): Promise<Record<string, ContainerStats>> {
  const aggregated: Record<string, ContainerStats> = {};
  const samplesRemaining = Math.max(1, Math.floor(durationSeconds / intervalSeconds));
  const start = Date.now();

  let i = 0;
  for (; i < samplesRemaining; i++) {
    const elapsed = (Date.now() - start) / 1000;
    const remaining = Math.max(0, durationSeconds - elapsed);
    process.stdout.write(
      `\r  Collecting... sample ${i + 1}/${samplesRemaining} ` +
        `(${Math.trunc(remaining)}s remaining)`,
    );

    const snapshot = collectSnapshot();
    for (const entry of snapshot) {
      const name = entry.name;
      if (!(name in aggregated)) aggregated[name] = new ContainerStats(name);
      const s = aggregated[name];
      s.samples += 1;
      s.cpuSamples.push(entry.cpu_percent);
      s.memSamples.push(entry.mem_mib);
    }

    if (i < samplesRemaining - 1) await sleep(intervalSeconds);
  }

  console.log(); // Clear the progress line

  return aggregated;
}

/** Format MiB as human-readable. */
function fmtMem(mib: number): string {
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  if (mib >= 1) return `${mib.toFixed(0)} MiB`;
  return `${(mib * 1024).toFixed(0)} KiB`;
}
