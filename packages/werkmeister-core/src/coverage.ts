/**
 * Unit-test coverage for the metrics ledger and the close-out record (SW-405), read from the
 * istanbul `coverage/coverage-summary.json` a package's `test:coverage` writes. Any repo whose
 * tests write that file is read the same way; nothing here is werkmeister-specific.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { type MetricsEvent, recordEvent } from "./metrics.js";
import { warn } from "./reporter.js";

const METRICS = ["lines", "branches", "functions", "statements"] as const;
type Metric = (typeof METRICS)[number];
type Counts = Record<Metric, { total: number; covered: number; pct: number | string }>;
type Pcts = Record<Metric, number>;
type Sums = Record<Metric, { covered: number; total: number }>;
const zero = () => Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }])) as Sums;

/** One package's coverage, as a summary row: what the ledger records. */
export interface PackageCoverage extends Pcts {
  name: string;
  version?: string;
  tests?: number | null;
  duration_ms?: number | null;
}

export interface CoverageReport {
  /** The folder holding `coverage/`. */
  pkgDir: string;
  /** istanbul's summary: `total`, then one entry per measured file keyed by its absolute path. */
  summary: Record<string, Counts>;
  pkg: PackageCoverage;
  mtimeMs: number;
}

// istanbul writes "Unknown" for a metric with nothing to count in some versions; 100 % is its newer answer.
const pctOf = (c: Counts[Metric]) => (typeof c.pct === "number" ? c.pct : 100);
const pct = (covered: number, total: number) =>
  total ? Math.round((covered / total) * 10000) / 100 : 100;
// Some filesystems (a bind mount from macOS) keep whole-second mtimes: a report written in the gate's first second reads as older.
const floorSecond = (ms: number) => Math.floor(ms / 1000) * 1000;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

const subdirs = (dir: string) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith("."))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};

/** The reports at *repoDir*, one level down and two (`apps/cli`). An unreadable report is skipped. */
export function findCoverageReports(repoDir: string): CoverageReport[] {
  const one = subdirs(repoDir);
  const out: CoverageReport[] = [];
  for (const dir of [repoDir, ...one, ...one.flatMap(subdirs)]) {
    const file = path.join(dir, "coverage", "coverage-summary.json");
    if (!fs.existsSync(file)) continue;
    try {
      const summary: Record<string, Counts> = readJson(file);
      const total = summary["total"];
      if (!total) continue;
      let meta: { name?: string; version?: string } = {};
      try {
        meta = readJson(path.join(dir, "package.json"));
      } catch {}
      let run: { tests?: number | null; duration_ms?: number | null } = {};
      try {
        run = readJson(path.join(dir, "coverage", "run.json"));
      } catch {}
      out.push({
        pkgDir: dir,
        summary,
        pkg: {
          name: meta.name ?? path.basename(dir),
          ...(meta.version && { version: meta.version }),
          ...(Object.fromEntries(METRICS.map((m) => [m, pctOf(total[m])])) as Pcts),
          tests: run.tests ?? null,
          duration_ms: run.duration_ms ?? null,
        },
        mtimeMs: fs.statSync(file).mtimeMs,
      });
    } catch (e) {
      warn(`coverage: skipped ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** One `coverage` event per package. `version` is the package's `version+<short sha>`, as on other events. */
export function coverageRows(
  pkgs: PackageCoverage[],
  ctx: { source: "ci-main" | "ci-pr" | "gate"; commit: string; workspace?: string; run?: string },
): MetricsEvent[] {
  // A CI artifact is a fork PR's own output: a row whose values don't fit the schema is dropped, never logged.
  const pctOk = (v: unknown) => typeof v === "number" && v >= 0 && v <= 100;
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const short = (v: unknown, n: number) => typeof v === "string" && v.length > 0 && v.length <= n;
  return pkgs
    .filter((p) => short(p.name, 214) && METRICS.every((m) => pctOk(p[m])))
    .map((p) => ({
      event: "coverage",
      ...(ctx.workspace && { workspace: ctx.workspace }),
      source: ctx.source,
      commit: ctx.commit,
      ...(ctx.run && { run: ctx.run }),
      package: p.name,
      ...(short(p.version, 64) && { version: `${p.version}+${ctx.commit.slice(0, 8)}` }),
      lines: p.lines,
      branches: p.branches,
      functions: p.functions,
      statements: p.statements,
      ...(count(p.tests) && { tests: p.tests as number }),
      ...(count(p.duration_ms) && { duration_ms: p.duration_ms as number }),
    }));
}

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST = /(\.test\.|\.spec\.|\.smoke\.|(^|\/)(test|tests|__tests__|bdd|fixtures)\/)/;

/**
 * Coverage of *changed* (repo-relative paths) from the reports' per-file entries. Their keys are
 * absolute, from wherever the tests ran (a container's `/app/...`), so a path matches by suffix.
 * `notMeasured`: changed source files, not tests, that no report holds.
 */
export function changedFileCoverage(reports: CoverageReport[], changed: string[]) {
  const files: Array<{ path: string } & Pcts> = [];
  const notMeasured: string[] = [];
  const sum = zero();
  for (const rel of changed) {
    const hit = reports
      .flatMap((r) => Object.entries(r.summary))
      .find(([k]) => k !== "total" && (k === rel || k.endsWith(`/${rel}`)))?.[1];
    if (!hit) {
      if (SOURCE.test(rel) && !TEST.test(rel)) notMeasured.push(rel);
      continue;
    }
    for (const m of METRICS) {
      sum[m].covered += hit[m].covered;
      sum[m].total += hit[m].total;
    }
    files.push({
      path: rel,
      ...(Object.fromEntries(METRICS.map((m) => [m, pctOf(hit[m])])) as Pcts),
    });
  }
  return { files, notMeasured, sum };
}

function git(dir: string, ...args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Logs a `coverage` row (source gate) per package report written since *sinceMs*; the count logged. Never throws. */
export function recordGateCoverage(
  worktree: string,
  workspace: string,
  run: string,
  sinceMs: number,
): number {
  try {
    const commit = git(worktree, "rev-parse", "HEAD");
    if (!commit) return 0;
    const fresh = findCoverageReports(worktree).filter((r) => r.mtimeMs >= floorSecond(sinceMs));
    const rows = coverageRows(
      fresh.map((r) => r.pkg),
      { source: "gate", commit, workspace, run },
    );
    return rows.filter((e) => recordEvent(e)).length;
  } catch (e) {
    warn(`coverage: gate rows not recorded: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Writes `<ws>/coverage.json`, the coverage of each PR's changed files, from reports newer than its
 * HEAD commit (an older report measured other code), and returns the close-out summary line. No fresh
 * report, no file and null. A retry keeps the first file, as `usage.json` does. Never throws.
 */
export function writeCoverageSnapshot(
  ws: string,
  prs: Array<{ dir: string; base: string }>,
): string | null {
  const file = path.join(ws, "coverage.json");
  if (fs.existsSync(file)) return "Coverage: see coverage.json";
  try {
    const repos: Record<string, unknown> = {};
    const sum = zero();
    let measuredAt = 0;
    for (const { dir, base } of prs) {
      const wt = path.join(ws, dir);
      const [commit = "", time = "0"] = (git(wt, "log", "-1", "--format=%H %ct") ?? "").split(" ");
      const reports = findCoverageReports(wt).filter((r) => r.mtimeMs >= Number(time) * 1000);
      if (!commit || !reports.length || repos[dir]) continue;
      const changed = (git(wt, "diff", "--name-only", `origin/${base}...HEAD`) ?? "")
        .split("\n")
        .filter(Boolean);
      const c = changedFileCoverage(reports, changed);
      for (const m of METRICS) {
        sum[m].covered += c.sum[m].covered;
        sum[m].total += c.sum[m].total;
      }
      measuredAt = Math.max(measuredAt, ...reports.map((r) => r.mtimeMs));
      repos[dir] = { commit, files: c.files, notMeasured: c.notMeasured };
    }
    if (!Object.keys(repos).length) return null;
    // null, not istanbul's 100 %, when no changed file was measured: nothing was covered.
    const total = sum.lines.total
      ? (Object.fromEntries(METRICS.map((m) => [m, pct(sum[m].covered, sum[m].total)])) as Pcts)
      : null;
    const snapshot = {
      schema: 1,
      source: "gate",
      measuredAt: new Date(measuredAt).toISOString(),
      repos,
      total,
    };
    fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    return total
      ? `Coverage of changed files: ${total.lines} % of lines, ${total.branches} % of branches; see coverage.json`
      : "Coverage: no changed file was measured; see coverage.json";
  } catch (e) {
    warn(`coverage: coverage.json not written: ${(e as Error).message}`);
    return null;
  }
}
