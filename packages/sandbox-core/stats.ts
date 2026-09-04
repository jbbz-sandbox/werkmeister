/**
 * Docker container resource statistics collection and analysis.
 *
 * Collects CPU/memory usage data from running containers over the Engine API
 * and generates resource limit recommendations based on observed peaks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { sandboxRoot } from "./config.js";
import { containerStats } from "./docker.js";
import { warn } from "./reporter.js";

/** Sleep, cut short by *signal* — the whole point of an abortable collection. */
function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Aggregated resource stats for a single container. */
export class ContainerStats {
  name: string;
  samples = 0;
  cpuSamples: number[] = [];
  memSamples: number[] = []; // in MiB

  constructor(name: string) {
    this.name = name;
  }

  get avgCpu(): number {
    return this.cpuSamples.length
      ? this.cpuSamples.reduce((a, b) => a + b, 0) / this.cpuSamples.length
      : 0.0;
  }

  get maxCpu(): number {
    return this.cpuSamples.length ? Math.max(...this.cpuSamples) : 0.0;
  }

  get avgMem(): number {
    return this.memSamples.length
      ? this.memSamples.reduce((a, b) => a + b, 0) / this.memSamples.length
      : 0.0;
  }

  get maxMem(): number {
    return this.memSamples.length ? Math.max(...this.memSamples) : 0.0;
  }
}

/**
 * Collect container stats over a time period.
 *
 * durationSeconds — how long to collect in seconds.
 * intervalSeconds — time between samples.
 * filterPrefix    — only include containers whose name starts with this prefix.
 * signal          — abort to stop sampling and return what has been collected.
 *
 * Returns a mapping of container name to aggregated stats.
 */
export async function collectStats(
  durationSeconds = 60,
  intervalSeconds = 10,
  filterPrefix = "",
  signal?: AbortSignal,
): Promise<Record<string, ContainerStats>> {
  const aggregated: Record<string, ContainerStats> = {};
  const samplesRemaining = Math.max(1, Math.floor(durationSeconds / intervalSeconds));

  for (let i = 0; i < samplesRemaining; i++) {
    // Aborting keeps the partial aggregate: a half-finished collection is still
    // the answer to "what was it using before I stopped it".
    if (signal?.aborted) break;
    const snapshot = await containerStats();
    for (const entry of snapshot) {
      const name = entry.name;
      if (filterPrefix && !name.startsWith(filterPrefix)) continue;
      if (!(name in aggregated)) aggregated[name] = new ContainerStats(name);
      const stats = aggregated[name];
      stats.samples += 1;
      stats.cpuSamples.push(entry.cpuPercent);
      stats.memSamples.push(entry.memMib);
    }

    if (i < samplesRemaining - 1) await sleep(intervalSeconds, signal);
  }

  return aggregated;
}


/** Format MiB as a human-readable string. */
export function formatMem(mib: number): string {
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)}G`;
  if (mib >= 1) return `${mib.toFixed(0)}M`;
  return `${(mib * 1024).toFixed(0)}K`;
}

export interface Recommendation {
  name: string;
  max_cpu_pct: number;
  max_mem_mib: number;
  recommended_cpus: string;
  recommended_memory: string;
  recommended_reservation: string;
}

/**
 * Generate resource limit recommendations based on observed stats.
 *
 * Uses max_usage * 1.5 (50% headroom), rounded to standard values.
 */
export function recommendLimits(stats: Record<string, ContainerStats>): Recommendation[] {
  const recommendations: Recommendation[] = [];

  for (const name of Object.keys(stats).sort()) {
    const s = stats[name];
    if (s.samples === 0) continue;

    // CPU: max * 1.5, rounded to standard increments
    const rawCpu = (s.maxCpu / 100.0) * 1.5; // maxCpu is a percentage
    const cpus = roundCpu(rawCpu);

    // Memory: max * 1.5, rounded to standard values
    const rawMem = s.maxMem * 1.5;
    const memory = roundMemory(rawMem);

    // Reservation: ~50% of limit
    const reservation = roundMemory(rawMem / 3); // headroom already in rawMem

    recommendations.push({
      name,
      max_cpu_pct: s.maxCpu,
      max_mem_mib: s.maxMem,
      recommended_cpus: cpus,
      recommended_memory: memory,
      recommended_reservation: reservation,
    });
  }

  return recommendations;
}

/** Round CPU to standard Docker Compose values. */
function roundCpu(cpus: number): string {
  if (cpus <= 0.1) return "0.1";
  if (cpus <= 0.25) return "0.25";
  if (cpus <= 0.5) return "0.5";
  if (cpus <= 1.0) return "1.0";
  if (cpus <= 1.5) return "1.5";
  if (cpus <= 2.0) return "2.0";
  return (Math.ceil(cpus * 2) / 2).toFixed(1);
}

/** Round memory to standard Docker Compose values (e.g., 128M, 256M, 512M, 1G, 2G). */
function roundMemory(mib: number): string {
  const standardMib = [64, 128, 256, 512, 1024, 1536, 2048, 2560, 3072, 4096, 6144, 8192];

  for (const s of standardMib) {
    if (mib <= s) return s < 1024 ? `${s}M` : `${Math.floor(s / 1024)}G`;
  }

  // Above 8G, round up to next GB
  return `${Math.ceil(mib / 1024)}G`;
}


/**
 * Return half of a CPU string value for reservations.
 *
 * Exported because `commands/stats.ts` renders the YAML snippet: the halving is
 * a resource-policy rule, so it stays here with `recommendLimits` rather than
 * moving into the renderer.
 */
export function halveCpu(cpusStr: string): string {
  return roundCpu(Number(cpusStr) / 2);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Save stats and recommendations to the stats/ directory.
 *
 * Returns the path to the summary file.
 */
export function saveReport(
  stats: Record<string, ContainerStats>,
  recommendations: Recommendation[],
): string {
  const statsDir = path.join(sandboxRoot(), "stats");
  if (!fs.existsSync(statsDir)) fs.mkdirSync(statsDir);

  const now = new Date();
  const timestamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

  // Save raw CSV (rows terminated \r\n)
  const csvPath = path.join(statsDir, `docker-stats-${timestamp}.csv`);
  const csvRows: string[] = [
    ["container", "avg_cpu_pct", "max_cpu_pct", "avg_mem_mib", "max_mem_mib", "samples"].join(","),
  ];
  for (const name of Object.keys(stats).sort()) {
    const s = stats[name];
    csvRows.push(
      [
        name,
        s.avgCpu.toFixed(1),
        s.maxCpu.toFixed(1),
        s.avgMem.toFixed(1),
        s.maxMem.toFixed(1),
        String(s.samples),
      ].join(","),
    );
  }
  fs.writeFileSync(csvPath, csvRows.join("\r\n") + "\r\n");

  // Save summary
  const summaryPath = path.join(statsDir, `resource-summary-${timestamp}.txt`);
  const generated =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  let out = "";
  out += "Docker Resource Usage Summary\n";
  out += `Generated: ${generated}\n`;
  out += "=".repeat(60) + "\n\n";
  out += "Per-Container Statistics:\n\n";
  // Write without ANSI codes
  for (const name of Object.keys(stats).sort()) {
    const s = stats[name];
    out +=
      `  ${name.padEnd(35)}  ` +
      `avg_cpu=${s.avgCpu.toFixed(1)}%  max_cpu=${s.maxCpu.toFixed(1)}%  ` +
      `avg_mem=${formatMem(s.avgMem)}  max_mem=${formatMem(s.maxMem)}\n`;
  }
  out += "\n\nRecommended Resource Limits:\n\n";
  for (const r of recommendations) {
    out +=
      `  ${r.name.padEnd(35)}  ` +
      `cpus: ${r.recommended_cpus.padStart(5)}  ` +
      `memory: ${r.recommended_memory.padStart(5)}\n`;
  }
  fs.writeFileSync(summaryPath, out);

  return summaryPath;
}

/**
 * What one `--collect` run produced.
 *
 * `stats` and `recommendations` are the data the caller renders; the other four
 * describe the run itself, which is the part an aborted collection has to be
 * honest about — `durationMinutes` is what elapsed, not what was asked for.
 */
export interface CollectionRun {
  stats: Record<string, ContainerStats>;
  recommendations: Recommendation[];
  samples: number;
  durationMinutes: number;
  saved: boolean;
  reportPath: string | null;
}

/**
 * Collect over a period, recommend limits from it, and optionally write a report.
 *
 * *signal* aborts the sampling loop and returns the partial aggregate. The CLI
 * has no signal to give yet — its Ctrl-C still ends the process outright (see
 * `apps/cli/src/lib/interrupt.ts`) — so it passes none and behaves exactly as
 * before; a remote caller can already abort.
 *
 * The report path comes back rather than being announced here: the CLI prints
 * "Report saved to: …" *after* its tables, and a `success()` from in here would
 * jump the queue.
 */
export async function runCollection(
  durationMinutes: number,
  intervalSeconds: number,
  save: boolean,
  signal?: AbortSignal,
): Promise<CollectionRun> {
  const started = Date.now();
  const stats = await collectStats(durationMinutes * 60, intervalSeconds, "", signal);
  const elapsedMinutes = (Date.now() - started) / 60_000;

  if (!Object.keys(stats).length) {
    warn("No container data collected.");
    return {
      stats,
      recommendations: [],
      samples: 0,
      durationMinutes: elapsedMinutes,
      saved: false,
      reportPath: null,
    };
  }

  const recommendations = recommendLimits(stats);
  const reportPath = save ? saveReport(stats, recommendations) : null;

  return {
    stats,
    recommendations,
    samples: Math.max(0, ...Object.values(stats).map((s) => s.samples)),
    durationMinutes: elapsedMinutes,
    saved: reportPath !== null,
    reportPath,
  };
}
