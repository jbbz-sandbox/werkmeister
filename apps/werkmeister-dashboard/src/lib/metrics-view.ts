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

/** The closed-workspaces preview, until SW-1100/1101 decide its chart. */
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
}

/** Each stage's summed minutes over the range, split by what it waited on (SW-1099 Q5). */
export function waitSplit(rows: SlicedRow[]): StageSplit[] {
  const s = slices(rows);
  const total = (st: string, k: keyof StageTrend) =>
    sum(s.map((x) => Number(x.stages[st]?.[k] ?? 0)));
  return stageNames(rows).map((stage) => ({
    stage,
    total: total(stage, "totalMinutes"),
    person: total(stage, "personMinutes"),
    capacity: total(stage, "capacityMinutes"),
    working: total(stage, "workingMinutes"),
  }));
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
