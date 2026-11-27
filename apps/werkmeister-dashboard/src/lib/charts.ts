/**
 * The Metrics and Flow tabs' chart primitives (SW-1098, SW-783): data → marks in a `W`-wide viewBox, no DOM, so the
 * smoke test asserts them. Inline SVG; the repo has no chart dependency. Labels are HTML, outside.
 */

export const W = 1000;

const r1 = (n: number) => Math.round(n * 10) / 10;
/** The centre of slot *i* of *n* across `W`, so lines, bars and heatmap columns line up. */
const slotX = (i: number, n: number) => ((i + 0.5) * W) / n;

export interface BandPoint {
  label: string;
  p50: number | null;
  p90: number | null;
}
export interface BandView {
  yMax: number;
  /** SVG path: the p50 line, a new `M` after each null point. */
  line: string;
  /** SVG path: one closed p50→p90 polygon per run of points. */
  band: string;
  dots: { x: number; y: number; label: string; p50: number; p90: number }[];
}

/** A p50 line over a shaded p50→p90 band. A point with a null p50 breaks both. */
export function lineBandView(points: BandPoint[], h: number): BandView {
  const present = points.map((p, i) =>
    p.p50 === null ? null : { i, label: p.label, p50: p.p50, p90: p.p90 ?? p.p50 },
  );
  const yMax = Math.max(1, ...present.map((p) => p?.p90 ?? 0));
  const y = (v: number) => r1(h - (v / yMax) * h);
  const runs: NonNullable<(typeof present)[number]>[][] = [];
  let run: NonNullable<(typeof present)[number]>[] = [];
  for (const p of present) {
    if (p) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  const pt = (i: number, v: number) => `${r1(slotX(i, points.length))} ${y(v)}`;
  return {
    yMax,
    line: runs
      .map((ps) => ps.map((p, k) => `${k ? "L" : "M"}${pt(p.i, p.p50)}`).join(" "))
      .join(" "),
    band: runs
      .map((ps) => {
        const top = ps.map((p, k) => `${k ? "L" : "M"}${pt(p.i, p.p90)}`);
        const bottom = [...ps].reverse().map((p) => `L${pt(p.i, p.p50)}`);
        return `${[...top, ...bottom].join(" ")} Z`;
      })
      .join(" "),
    dots: runs.flat().map((p) => ({
      x: r1(slotX(p.i, points.length)),
      y: y(p.p50),
      label: p.label,
      p50: p.p50,
      p90: p.p90,
    })),
  };
}

export interface LineSeries {
  key: string;
  /** One per slot; null breaks the line. */
  values: (number | null)[];
}
export interface MultiLineView {
  yMax: number;
  lines: {
    key: string;
    d: string;
    dots: { x: number; y: number; slot: number; value: number }[];
  }[];
}

/** One line per series over shared slots, on one y scale. */
export function multiLineView(series: LineSeries[], h: number): MultiLineView {
  const yMax = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  return {
    yMax,
    lines: series.map((s) => {
      const dots = s.values.flatMap((v, slot) =>
        v === null
          ? []
          : [{ x: r1(slotX(slot, s.values.length)), y: r1(h - (v / yMax) * h), slot, value: v }],
      );
      const d = dots
        .map((p, k) => `${k && dots[k - 1].slot === p.slot - 1 ? "L" : "M"}${p.x} ${p.y}`)
        .join(" ");
      return { key: s.key, d, dots };
    }),
  };
}

export interface StackBar {
  label: string;
  values: Record<string, number>;
}
export interface StackedBarView {
  yMax: number;
  bars: {
    label: string;
    x: number;
    width: number;
    segments: { key: string; y: number; height: number; value: number }[];
  }[];
}

/** One bar per entry, its segments stacked bottom-up in *keys* order; zero segments left out. */
export function stackedBarView(bars: StackBar[], keys: string[], h: number): StackedBarView {
  const total = (b: StackBar) => keys.reduce((a, k) => a + Math.max(0, b.values[k] ?? 0), 0);
  const yMax = Math.max(1, ...bars.map(total));
  const slot = W / Math.max(bars.length, 1);
  return {
    yMax,
    bars: bars.map((b, i) => {
      let below = 0;
      const segments = [];
      for (const key of keys) {
        const value = b.values[key] ?? 0;
        if (value <= 0) continue;
        below += value;
        segments.push({
          key,
          y: r1(h - (below / yMax) * h),
          height: r1((value / yMax) * h),
          value,
        });
      }
      return { label: b.label, x: r1(i * slot + slot * 0.15), width: r1(slot * 0.7), segments };
    }),
  };
}

export interface HorizontalStackedBarView {
  xMax: number;
  rows: {
    label: string;
    y: number;
    segments: { key: string; x: number; width: number; value: number }[];
  }[];
}

/** {@link stackedBarView} on its side: one row per bar, `rowH` apart, segments left to right in *keys* order across *w*. */
export function horizontalStackedBarView(
  bars: StackBar[],
  keys: string[],
  w: number,
  rowH: number,
): HorizontalStackedBarView {
  const v = stackedBarView(bars, keys, w);
  return {
    xMax: v.yMax,
    rows: v.bars.map((b, i) => ({
      label: b.label,
      y: i * rowH,
      segments: b.segments.map((s) => ({
        key: s.key,
        x: r1(w - s.y - s.height),
        width: s.height,
        value: s.value,
      })),
    })),
  };
}

export interface ScatterView {
  yMax: number;
  p50Y: number | null;
  p90Y: number | null;
  dots: { x: number; y: number; label: string; value: number; over: boolean }[];
}

/** Dots at (t, value) across `W × h`, x from *x0* to *x1* (ms); `over` when the value is past p90. */
export function scatterView(
  points: { t: number; value: number; label: string }[],
  p50: number | null,
  p90: number | null,
  x0: number,
  x1: number,
  h: number,
): ScatterView {
  const yMax = Math.max(1, p90 ?? 0, ...points.map((p) => p.value));
  const y = (v: number) => r1(h - (v / yMax) * h);
  const x = (t: number) => (x1 > x0 ? r1(((t - x0) / (x1 - x0)) * W) : W / 2);
  return {
    yMax,
    p50Y: p50 === null ? null : y(p50),
    p90Y: p90 === null ? null : y(p90),
    dots: points.map((p) => ({
      x: x(p.t),
      y: y(p.value),
      label: p.label,
      value: p.value,
      over: p90 !== null && p.value > p90,
    })),
  };
}

export interface HeatmapView {
  max: number;
  cells: {
    row: string;
    col: string;
    x: number;
    y: number;
    width: number;
    height: number;
    value: number | null;
    /** value ÷ max, 0..1; null where there is no value. */
    intensity: number | null;
  }[];
}

/** `grid[row][col]` as cells tiling `W × h`. */
export function heatmapView(
  rowLabels: string[],
  colLabels: string[],
  grid: (number | null)[][],
  h: number,
): HeatmapView {
  const values = grid.flat().filter((v): v is number => v !== null);
  const max = Math.max(0, ...values);
  const width = W / Math.max(colLabels.length, 1);
  const height = h / Math.max(rowLabels.length, 1);
  return {
    max,
    cells: rowLabels.flatMap((row, ri) =>
      colLabels.map((col, ci) => {
        const value = grid[ri]?.[ci] ?? null;
        return {
          row,
          col,
          x: r1(ci * width),
          y: r1(ri * height),
          width: r1(width),
          height: r1(height),
          value,
          intensity: value === null ? null : max ? value / max : 0,
        };
      }),
    ),
  };
}

export interface StatTile {
  label: string;
  value: string;
  sub?: string;
}

/** A labelled number; `—` when unknown. */
export function statTile(
  label: string,
  value: number | null,
  format: (n: number) => string,
  sub?: string,
): StatTile {
  return { label, value: value === null ? "—" : format(value), ...(sub ? { sub } : {}) };
}

/** `$0.42`, `$12`, `$1.2k`. */
export function formatUsd(n: number): string {
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${Math.round(n)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}
