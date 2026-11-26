/**
 * The Metrics tab's view model (SW-1098, SW-1099): `metrics-trends` rows → the version list, the
 * empty state, the stat tiles and each chart's input. Pure, so the smoke test needs no DOM.
 */
import type {
  MetricsRange,
  MetricsTrends,
  SlowTicket,
  StageTrend,
  TrendBucket,
  TrendSlice,
} from "werkmeister-core/metrics_report";
import { formatUsd, type LineSeries, type StackBar, type StatTile, statTile } from "./charts.js";

/** `"all"` or one `byVersion` key. */
export type VersionFilter = string;
/** Daily points only for 7d: over longer ranges a day's p50/p90 rests on one or two runs (SW-1098 Q3). */
export const RANGE_BUCKET: Record<MetricsRange, TrendBucket> = {
  "7d": "day",
  "30d": "week",
  "90d": "week",
  all: "week",
};

export interface SlicedRow {
  bucket: string;
  /** null when the chosen version has nothing in this bucket. */
  slice: TrendSlice | null;
}

/** Every version in *t*, newest first, `unknown` last. */
export function versionsOf(t: MetricsTrends): string[] {
  const seen = new Set(t.rows.flatMap((r) => Object.keys(r.byVersion)));
  return [...seen].sort((a, b) =>
    a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a, undefined, { numeric: true }),
  );
}

export function sliceRows(t: MetricsTrends, v: VersionFilter): SlicedRow[] {
  return t.rows.map((r) => ({
    bucket: r.bucket,
    slice: v === "all" ? r : (r.byVersion[v] ?? null),
  }));
}

const hasActivity = (s: TrendSlice) =>
  s.shipped +
    s.abandoned +
    s.leadToMerge.count +
    s.leadToRelease.count +
    s.gate.runs +
    s.gate.workspaces >
    0 || Object.keys(s.stages).length > 0;

/**
 * No closed workspace, finished stage, lead time or gate run in range: gate runs and merges land
 * before any close-out snapshot does (SW-1098 Q6, revised). Rows never go missing; they're zeros.
 */
export const isEmpty = (rows: SlicedRow[]) => !rows.some((r) => r.slice && hasActivity(r.slice));

export function emptyText(range: MetricsRange, v: VersionFilter): string {
  const base =
    range === "all"
      ? "No activity yet"
      : `No activity in the last ${Number.parseInt(range, 10)} days`;
  if (v === "all") return base;
  return v === "unknown" ? `${base} with no version recorded` : `${base} for ${v}`;
}

const slices = (rows: SlicedRow[]) => rows.flatMap((r) => (r.slice ? [r.slice] : []));
const sum = (ns: number[]) => ns.reduce((a, n) => a + n, 0);

export function metricsTiles(rows: SlicedRow[]): StatTile[] {
  const s = slices(rows);
  const priced = s.flatMap((x) => (x.estUsd === null ? [] : [x.estUsd]));
  const passed = sum(s.map((x) => x.gate.passed));
  const gated = sum(s.map((x) => x.gate.workspaces));
  return [
    statTile("Shipped", sum(s.map((x) => x.shipped)), String),
    statTile("Abandoned", sum(s.map((x) => x.abandoned)), String),
    statTile("Est. cost", priced.length ? sum(priced) : null, formatUsd),
    statTile(
      "Gate first pass",
      gated ? passed / gated : null,
      (n) => `${Math.round(n * 100)}%`,
      gated ? `${passed} of ${gated} workspaces` : undefined,
    ),
  ];
}

export interface PreviewCharts {
  closed: StackBar[];
  closedKeys: string[];
}

/** The closed-workspaces preview, until SW-1100 decides its chart. */
export function previewCharts(rows: SlicedRow[]): PreviewCharts {
  return {
    closed: rows.map((r) => ({
      label: r.bucket,
      values: { shipped: r.slice?.shipped ?? 0, abandoned: r.slice?.abandoned ?? 0 },
    })),
    closedKeys: ["shipped", "abandoned"],
  };
}

export type Pct = "p50" | "p90";
const pctKey = (p: Pct) => (p === "p50" ? "p50Minutes" : "p90Minutes");

/** Stages present in *rows*, in pipeline order (their names sort that way). */
export const stageNames = (rows: SlicedRow[]) =>
  [...new Set(slices(rows).flatMap((s) => Object.keys(s.stages)))].sort();

export interface TrendLines {
  cols: string[];
  series: (LineSeries & { counts: number[] })[];
}

/** One line per stage: its p50 or p90 minutes per bucket (SW-1099 Q3). */
export function stageTrend(rows: SlicedRow[], p: Pct): TrendLines {
  return {
    cols: rows.map((r) => r.bucket),
    series: stageNames(rows).map((st) => ({
      key: st,
      values: rows.map((r) => r.slice?.stages[st]?.[pctKey(p)] ?? null),
      counts: rows.map((r) => r.slice?.stages[st]?.count ?? 0),
    })),
  };
}

/** Lead time to merge and to release, p50 or p90 per bucket. */
export function leadTrend(rows: SlicedRow[], p: Pct): TrendLines {
  const line = (key: string, of: (s: TrendSlice) => TrendSlice["leadToMerge"]) => ({
    key,
    values: rows.map((r) => (r.slice ? of(r.slice)[pctKey(p)] : null)),
    counts: rows.map((r) => (r.slice ? of(r.slice).count : 0)),
  });
  return {
    cols: rows.map((r) => r.bucket),
    series: [line("merged", (s) => s.leadToMerge), line("released", (s) => s.leadToRelease)],
  };
}

export function stageHeatmap(rows: SlicedRow[]) {
  const names = stageNames(rows);
  return {
    rows: names,
    cols: rows.map((r) => r.bucket),
    grid: names.map((st) => rows.map((r) => r.slice?.stages[st]?.p50Minutes ?? null)),
  };
}

export interface StageSplit {
  stage: string;
  total: number;
  person: number;
  capacity: number;
  working: number;
  /** Minutes waiting on anything, each minute once: `person + capacity` can exceed it when they overlap. */
  waiting: number;
}

/** Each stage's summed minutes over the range, split by what it waited on (SW-1099 Q5). */
export function waitSplit(rows: SlicedRow[]): StageSplit[] {
  const s = slices(rows);
  const total = (st: string, k: keyof StageTrend) =>
    sum(s.map((x) => Number(x.stages[st]?.[k] ?? 0)));
  return stageNames(rows).map((stage) => {
    const all = total(stage, "totalMinutes");
    const working = total(stage, "workingMinutes");
    return {
      stage,
      total: all,
      person: total(stage, "personMinutes"),
      capacity: total(stage, "capacityMinutes"),
      working,
      waiting: Math.max(0, all - working),
    };
  });
}

/** Fewer stage completions than this in range and no stage is flagged: one run is not a pattern. */
const MIN_COMPLETIONS = 3;

/**
 * The stage with the largest share of summed wall minutes in range (SW-1099 Q2); a tie goes to
 * the later stage. Null under `MIN_COMPLETIONS` completions or with no minutes.
 */
export function bottleneck(
  rows: SlicedRow[],
): { stage: string; share: number; text: string } | null {
  const s = slices(rows);
  const completions = sum(s.flatMap((x) => Object.values(x.stages).map((st) => st.count)));
  const split = waitSplit(rows);
  const all = sum(split.map((x) => x.total));
  if (completions < MIN_COMPLETIONS || all === 0) return null;
  const top = split.reduce((a, x) => (x.total >= a.total ? x : a));
  const share = top.total / all;
  return {
    stage: top.stage,
    share,
    text: `${top.stage}: ${Math.round(share * 100)}% of stage time`,
  };
}

const lead = (t: SlowTicket) => t.leadToReleaseMinutes ?? t.leadToMergeMinutes ?? 0;

/** Up to 5 tickets with the longest lead over the range, each workspace once (SW-1099 Q6). */
export function slowestTickets(rows: SlicedRow[]): SlowTicket[] {
  const byWs = new Map<string, SlowTicket>();
  for (const t of slices(rows).flatMap((x) => x.slowest)) {
    const seen = byWs.get(t.workspace);
    byWs.set(t.workspace, {
      ...t,
      leadToMergeMinutes: t.leadToMergeMinutes ?? seen?.leadToMergeMinutes ?? null,
      leadToReleaseMinutes: t.leadToReleaseMinutes ?? seen?.leadToReleaseMinutes ?? null,
    });
  }
  return [...byWs.values()].sort((a, b) => lead(b) - lead(a)).slice(0, 5);
}

/** The stacked gate-minutes chart's row kinds, in stack order (SW-1101 Q3). */
export const GATE_KINDS = ["setup", "lint", "test", "release", "checks"] as const;

/** Gate minutes per bucket, stacked by row kind (SW-1101 Q9). */
export function gateKindBars(rows: SlicedRow[]): StackBar[] {
  return rows.map((r) => ({
    label: r.bucket,
    values: Object.fromEntries(GATE_KINDS.map((k) => [k, r.slice?.gate.byKind[k] ?? 0])),
  }));
}

const packagesOf = (rows: SlicedRow[]) =>
  [...new Set(slices(rows).flatMap((s) => Object.keys(s.tests)))].sort();

/** One line per package: its uncached test minutes, p50 or p90, per bucket (SW-1101 Q9). */
export function testTrend(rows: SlicedRow[], p: Pct): TrendLines {
  return {
    cols: rows.map((r) => r.bucket),
    series: packagesOf(rows).map((pkg) => ({
      key: pkg,
      values: rows.map((r) => r.slice?.tests[pkg]?.[pctKey(p)] ?? null),
      counts: rows.map((r) => r.slice?.tests[pkg]?.count ?? 0),
    })),
  };
}

export interface SlowSuite {
  package: string;
  /** p90 over the whole range. */
  p90Minutes: number;
  runs: number;
  /** p50 per bucket, for the sparkline. */
  spark: (number | null)[];
  /** p50 of the latest bucket with runs. */
  latestP50: number | null;
  /** latestP50 above the range p90: drawn in the warn colour (SW-1101 Q10). */
  slow: boolean;
}

/** The five packages with the highest test p90 over the range (SW-1101 Q9). */
export function slowestSuites(t: MetricsTrends, rows: SlicedRow[], v: VersionFilter): SlowSuite[] {
  const suites = (v === "all" ? t.suites : t.suitesByVersion[v]) ?? {};
  return Object.entries(suites)
    .flatMap(([pkg, s]) => (s.p90Minutes === null ? [] : [{ pkg, s, p90: s.p90Minutes }]))
    .sort((a, b) => b.p90 - a.p90)
    .slice(0, 5)
    .map(({ pkg, s, p90 }) => {
      const spark = rows.map((r) => r.slice?.tests[pkg]?.p50Minutes ?? null);
      const latestP50 = spark.filter((x): x is number => x !== null).at(-1) ?? null;
      return {
        package: pkg,
        p90Minutes: p90,
        runs: s.count,
        spark,
        latestP50,
        slow: latestP50 !== null && latestP50 > p90,
      };
    });
}

/** Gate first-pass rate per bucket, 0–1, null with no first run (SW-1101 Q9); its count is the workspaces. */
export function firstPassLine(rows: SlicedRow[]): TrendLines {
  return {
    cols: rows.map((r) => r.bucket),
    series: [
      {
        key: "first pass",
        values: rows.map((r) => r.slice?.gate.firstPassRate ?? null),
        counts: rows.map((r) => r.slice?.gate.workspaces ?? 0),
      },
    ],
  };
}

export interface TestRegression {
  package: string;
  beforeP50: number;
  afterP50: number;
  /** A version with runs of the package in the slower bucket, or null. */
  version: string | null;
  text: string;
}

/** Fewer uncached runs than this in a bucket, and it can't show a regression (SW-1101 Q11). */
const MIN_RUNS = 3;

/**
 * A package whose test p50 in the latest complete bucket is ≥ 25 % and ≥ 30 s above the median of
 * its previous three buckets' p50, each with `MIN_RUNS` runs (SW-1101 Q11; three, not four, so the
 * default 30d range, four complete weeks, can show it); the largest rise wins.
 */
export function testRegression(t: MetricsTrends, rows: SlicedRow[]): TestRegression | null {
  // The last row is the bucket still filling.
  const done = rows.slice(0, -1);
  if (done.length < 4) return null;
  const latest = done.at(-1);
  const before = done.slice(-4, -1);
  let best: TestRegression | null = null;
  for (const pkg of packagesOf(rows)) {
    const now = latest?.slice?.tests[pkg];
    const prior = before.map((r) => r.slice?.tests[pkg]);
    if (!now || now.count < MIN_RUNS || now.p50Minutes === null) continue;
    if (prior.some((p) => !p || p.count < MIN_RUNS || p.p50Minutes === null)) continue;
    const ps = prior.map((p) => p?.p50Minutes as number).sort((a, b) => a - b);
    const median = ps[1];
    const after = now.p50Minutes;
    if (after < median * 1.25 || after - median < 0.5) continue;
    if (best && after - median <= best.afterP50 - best.beforeP50) continue;
    const row = t.rows.find((r) => r.bucket === latest?.bucket);
    const version =
      Object.entries(row?.byVersion ?? {}).find(
        ([v, s]) => v !== "unknown" && (s.tests[pkg]?.count ?? 0) > 0,
      )?.[0] ?? null;
    best = {
      package: pkg,
      beforeP50: median,
      afterP50: after,
      version,
      text: `${pkg} tests slowed: ${formatTestMinutes(median)} → ${formatTestMinutes(after)} p50${version ? ` (first seen in ${version})` : ""}`,
    };
  }
  return best;
}

/** Test minutes as seconds under a minute: most suites run in seconds, which formatMinutes rounds to 0m. */
export const formatTestMinutes = (m: number | null) =>
  m === null ? "—" : m < 1 ? `${Math.round(m * 60)} s` : `${m.toFixed(1)} min`;
