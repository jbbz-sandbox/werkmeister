/**
 * The Metrics tab's view model (SW-1098): `metrics-trends` rows → the version list, the empty
 * state, the stat tiles and the preview charts' inputs. Pure, so the smoke test needs no DOM.
 */
import type {
  MetricsRange,
  MetricsTrends,
  TrendBucket,
  TrendSlice,
} from "werkmeister-core/metrics_report";
import { type BandPoint, formatUsd, type StackBar, type StatTile, statTile } from "./charts.js";

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
  lead: BandPoint[];
  closed: StackBar[];
  closedKeys: string[];
  stages: { rows: string[]; cols: string[]; grid: (number | null)[][] };
}

/** One preview per primitive until SW-1099–1101 bring the real charts. */
export function previewCharts(rows: SlicedRow[]): PreviewCharts {
  const stageNames = [...new Set(slices(rows).flatMap((s) => Object.keys(s.stages)))].sort();
  return {
    lead: rows.map((r) => ({
      label: r.bucket,
      p50: r.slice?.leadToMerge.p50Minutes ?? null,
      p90: r.slice?.leadToMerge.p90Minutes ?? null,
    })),
    closed: rows.map((r) => ({
      label: r.bucket,
      values: { shipped: r.slice?.shipped ?? 0, abandoned: r.slice?.abandoned ?? 0 },
    })),
    closedKeys: ["shipped", "abandoned"],
    stages: {
      rows: stageNames,
      cols: rows.map((r) => r.bucket),
      grid: stageNames.map((st) => rows.map((r) => r.slice?.stages[st]?.p50Minutes ?? null)),
    },
  };
}
