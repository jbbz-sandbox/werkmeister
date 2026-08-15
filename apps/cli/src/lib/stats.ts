/**
 * Docker container resource statistics collection and analysis.
 *
 * Collects CPU/memory usage data from running containers via `docker stats`
 * and generates resource limit recommendations based on observed peaks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors, getSandboxRoot } from "./config.js";
import { ProcError, run } from "./proc.js";

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
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

export interface SnapshotEntry {
  name: string;
  cpu_percent: number;
  mem_mib: number;
  mem_limit_mib: number;
}

/**
 * Collect a single snapshot of all running container stats.
 *
 * Returns a list of dicts with keys: name, cpu_percent, mem_mib, mem_limit_mib.
 */
export function collectSnapshot(): SnapshotEntry[] {
  let result;
  try {
    result = run(
      ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
      { capture: true, timeout: 30 },
    );
  } catch (e) {
    // FileNotFoundError / TimeoutExpired equivalents
    if (e instanceof ProcError && (e.code === "ENOENT" || e.code === "ETIMEDOUT")) return [];
    throw e;
  }

  if (result.status !== 0) return [];

  const entries: SnapshotEntry[] = [];
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const name = parts[0].trim();
    const cpuStr = parts[1].trim().replace(/%+$/, "");
    const memStr = parts[2].trim();

    let cpuPct = Number(cpuStr);
    if (!Number.isFinite(cpuPct)) cpuPct = 0.0;

    entries.push({
      name,
      cpu_percent: cpuPct,
      mem_mib: parseMemUsage(memStr),
      mem_limit_mib: parseMemLimit(memStr),
    });
  }

  return entries;
}

/** Parse the usage portion of '123.4MiB / 2GiB' into MiB. */
function parseMemUsage(memStr: string): number {
  return memToMib(memStr.split("/")[0].trim());
}

/** Parse the limit portion of '123.4MiB / 2GiB' into MiB. */
function parseMemLimit(memStr: string): number {
  const parts = memStr.split("/");
  if (parts.length < 2) return 0.0;
  return memToMib(parts[1].trim());
}

/** Convert a Docker memory string (e.g., '1.23GiB', '456MiB', '789KiB') to MiB. */
function memToMib(s: string): number {
  s = s.trim();
  let v: number;
  if (s.endsWith("GiB")) v = Number(s.slice(0, -3)) * 1024;
  else if (s.endsWith("MiB")) v = Number(s.slice(0, -3));
  else if (s.endsWith("KiB")) v = Number(s.slice(0, -3)) / 1024;
  else if (s.endsWith("B")) v = Number(s.slice(0, -1)) / (1024 * 1024);
  else v = Number(s);
  return Number.isFinite(v) ? v : 0.0;
}

/**
 * Collect container stats over a time period.
 *
 * durationSeconds — how long to collect in seconds.
 * intervalSeconds — time between samples.
 * filterPrefix    — only include containers whose name starts with this prefix.
 *
 * Returns a mapping of container name to aggregated stats.
 */
export async function collectStats(
  durationSeconds = 60,
  intervalSeconds = 10,
  filterPrefix = "",
): Promise<Record<string, ContainerStats>> {
  const aggregated: Record<string, ContainerStats> = {};
  const samplesRemaining = Math.max(1, Math.floor(durationSeconds / intervalSeconds));

  for (let i = 0; i < samplesRemaining; i++) {
    const snapshot = collectSnapshot();
    for (const entry of snapshot) {
      const name = entry.name;
      if (filterPrefix && !name.startsWith(filterPrefix)) continue;
      if (!(name in aggregated)) aggregated[name] = new ContainerStats(name);
      const stats = aggregated[name];
      stats.samples += 1;
      stats.cpuSamples.push(entry.cpu_percent);
      stats.memSamples.push(entry.mem_mib);
    }

    if (i < samplesRemaining - 1) await sleep(intervalSeconds);
  }

  return aggregated;
}

/** Format stats as a human-readable table. */
export function formatStatsTable(stats: Record<string, ContainerStats>): string {
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

/** Format recommendations as a human-readable report. */
export function formatRecommendations(recommendations: Recommendation[]): string {
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

/** Return half of a CPU string value for reservations. */
function halveCpu(cpusStr: string): string {
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
  const statsDir = path.join(getSandboxRoot(), "stats");
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
