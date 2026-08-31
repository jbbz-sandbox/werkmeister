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
import { containerStats } from "sandbox-core/docker";
import {
  ContainerStats,
  collectStats,
  formatMem,
  halveCpu,
  recommendLimits,
  saveReport,
  type Recommendation,
} from "sandbox-core/stats";

// The two table renderers live here rather than in `sandbox-core/stats`:
// §3 keeps table rendering CLI-side, and 066 split `status` the same way.
// `formatMem` stays in the library — `saveReport` writes it into the report
// file, and `commands/optimize.ts` reads it too.

/** Format stats as a human-readable table. */
function formatStatsTable(stats: Record<string, ContainerStats>): string {
  if (Object.keys(stats).length === 0) return "  No container data collected.";

  const lines: string[] = [];
  const header =
    `  ${Colors.BOLD}${"Container".padEnd(35)}  ` +
    `${"Avg CPU".padStart(8)}  ${"Max CPU".padStart(8)}  ` +
    `${"Avg Mem".padStart(8)}  ${"Max Mem".padStart(8)}  ` +
    `${"Samples".padStart(7)}${Colors.RESET}`;
  lines.push(header);
  lines.push(`  ${"─".repeat(85)}`);

  for (const name of Object.keys(stats).sort()) {
    const s = stats[name];
    lines.push(
      `  ${name.padEnd(35)}  ` +
        `${s.avgCpu.toFixed(1).padStart(7)}%  ${s.maxCpu.toFixed(1).padStart(7)}%  ` +
        `${formatMem(s.avgMem).padStart(8)}  ${formatMem(s.maxMem).padStart(8)}  ` +
        `${String(s.samples).padStart(7)}`,
    );
  }

  return lines.join("\n");
}

/** Format recommendations as a human-readable report. */
function formatRecommendations(recommendations: Recommendation[]): string {
  if (recommendations.length === 0) {
    return "  No recommendations available (no data collected).";
  }

  const lines: string[] = [];

  // Summary table
  const header =
    `  ${Colors.BOLD}${"Container".padEnd(35)}  ` +
    `${"Max CPU".padStart(8)}  ${"Max Mem".padStart(8)}  ` +
    `${"Rec. CPU".padStart(9)}  ${"Rec. Mem".padStart(9)}  ` +
    `${"Rec. Rsrv".padStart(9)}${Colors.RESET}`;
  lines.push(header);
  lines.push(`  ${"─".repeat(90)}`);

  for (const r of recommendations) {
    lines.push(
      `  ${r.name.padEnd(35)}  ` +
        `${r.max_cpu_pct.toFixed(1).padStart(7)}%  ${formatMem(r.max_mem_mib).padStart(8)}  ` +
        `${r.recommended_cpus.padStart(9)}  ${r.recommended_memory.padStart(9)}  ` +
        `${r.recommended_reservation.padStart(9)}`,
    );
  }

  lines.push("");
  lines.push(`  ${Colors.BOLD}YAML Snippets:${Colors.RESET}`);
  lines.push("");

  for (const r of recommendations) {
    lines.push(`  # ${r.name}`);
    lines.push("  deploy:");
    lines.push("    resources:");
    lines.push("      limits:");
    lines.push(`        cpus: "${r.recommended_cpus}"`);
    lines.push(`        memory: ${r.recommended_memory}`);
    lines.push("      reservations:");
    lines.push(`        cpus: "${halveCpu(r.recommended_cpus)}"`);
    lines.push(`        memory: ${r.recommended_reservation}`);
    lines.push("");
  }

  return lines.join("\n");
}

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
    await runSnapshot(save);
  }
}

/** Show a one-shot snapshot of current container stats. */
async function runSnapshot(_save: boolean): Promise<void> {
  const snapshot = await containerStats();

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
    const cpu = e.cpuPercent;
    const mem = e.memMib;
    const limit = e.memLimitMib;
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
    // Node delivers Ctrl+C as SIGINT (process termination), so this fallback
    // only fires for other surfaced interruptions.
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

    const snapshot = await containerStats();
    for (const entry of snapshot) {
      const name = entry.name;
      if (!(name in aggregated)) aggregated[name] = new ContainerStats(name);
      const s = aggregated[name];
      s.samples += 1;
      s.cpuSamples.push(entry.cpuPercent);
      s.memSamples.push(entry.memMib);
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
