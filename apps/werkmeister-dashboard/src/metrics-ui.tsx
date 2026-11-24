/**
 * "Metrics" dashboard tab (SW-1098): the `metrics-trends` series over a range, filtered by
 * werkmeister version, drawn with the inline-SVG primitives in lib/charts.ts. The charts here are
 * previews; SW-1099–1101 replace them with the stage, token and test charts.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { MetricsRange, MetricsTrends } from "werkmeister-core/metrics_report";
import { Css } from "werkmeister-ui/theme";
import type { HostBridge } from "werkmeister-ui/workspace-ui";
import {
  type BandPoint,
  heatmapView,
  lineBandView,
  type StackBar,
  stackedBarView,
  W,
} from "./lib/charts.js";
import { formatMinutes, RANGES } from "./lib/flow-board.js";
import {
  emptyText,
  isEmpty,
  metricsTiles,
  previewCharts,
  RANGE_BUCKET,
  sliceRows,
  versionsOf,
} from "./lib/metrics-view.js";

const CSS = `
  .metrics, .metrics * { box-sizing: border-box; }
  .metrics { font-family: var(--sd-sans); color: var(--sd-ink); padding: 16px 20px 40px; }
  .metrics .controls { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 4px 0 12px; }
  .metrics .ranges { display: flex; gap: 6px; padding: 0; margin: 0; border: 0; min-width: 0; }
  .metrics .ranges button, .metrics select {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--sd-ink);
    padding: 6px 12px; border: 1px solid var(--sd-ctl); border-radius: 8px; background: var(--sd-card);
  }
  .metrics select { max-width: 100%; }
  .metrics .ranges button[aria-pressed="true"] { background: var(--sd-accent); border-color: var(--sd-accent); color: var(--sd-on-accent); }
  .metrics .load-status { color: var(--sd-muted); font-size: 13px; min-height: 1em; margin-bottom: 8px; }
  .metrics .load-status.err { color: var(--sd-err); }
  .metrics .empty { color: var(--sd-muted); font-size: 14px; padding: 24px 0; }
  .metrics .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .metrics .tile, .metrics .chart { background: var(--sd-card); border: 1px solid var(--sd-line); border-radius: 10px; padding: 10px 12px; min-width: 0; }
  .metrics .tile .l { font-size: 12px; color: var(--sd-muted); }
  .metrics .tile .v { font-size: 22px; font-weight: 700; margin-top: 2px; }
  .metrics .tile .s { font-size: 12px; color: var(--sd-faint); }
  .metrics .chart { margin-bottom: 12px; }
  .metrics .chart h3 { font-size: 13px; margin: 0; }
  .metrics .chart .cap { font-size: 11px; color: var(--sd-faint); margin: 2px 0 6px; }
  .metrics .plot { display: flex; gap: 8px; min-width: 0; }
  .metrics .chart svg { flex: 1; min-width: 0; width: 100%; display: block; }
  .metrics .ylabels { display: flex; flex-direction: column; flex: none; font-size: 11px; color: var(--sd-muted); }
  .metrics .ylabels span { flex: 1; display: flex; align-items: center; }
  .metrics .xlabels { display: flex; justify-content: space-between; font-size: 11px; color: var(--sd-muted); margin-top: 2px; }
`;

const H = 120;

function XLabels({ cols }: { cols: string[] }) {
  if (!cols.length) return null;
  return (
    <div className="xlabels">
      <span>{cols[0]}</span>
      {cols.length > 1 && <span>{cols[cols.length - 1]}</span>}
    </div>
  );
}

function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="chart">
      <h3>{title}</h3>
      <div className="cap">Preview — replaced by SW-1099–1101</div>
      {children}
    </section>
  );
}

function LineBand({ points }: { points: BandPoint[] }) {
  const v = lineBandView(points, H);
  if (!v.dots.length) return <div className="empty">No merges in this range.</div>;
  return (
    <>
      <div className="xlabels">
        <span>{formatMinutes(v.yMax)}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        height={H}
        role="img"
        aria-label="Lead time to merge per bucket, p50 line over a p50 to p90 band"
      >
        <path d={v.band} fill="var(--sd-accent)" fillOpacity={0.2} stroke="none" />
        <path
          d={v.line}
          fill="none"
          stroke="var(--sd-accent)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {v.dots.map((d) => (
          // A zero-length round-capped stroke stays a circle under preserveAspectRatio="none".
          <path
            key={d.label}
            d={`M${d.x} ${d.y} h0`}
            stroke="var(--sd-accent)"
            strokeWidth={8}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${d.label}: p50 ${formatMinutes(d.p50)}, p90 ${formatMinutes(d.p90)}`}</title>
          </path>
        ))}
      </svg>
      <XLabels cols={points.map((p) => p.label)} />
    </>
  );
}

const STACK_FILL: Record<string, string> = {
  shipped: "var(--sd-ok)",
  abandoned: "var(--sd-muted)",
};

function StackedBars({ bars, keys }: { bars: StackBar[]; keys: string[] }) {
  const v = stackedBarView(bars, keys, H);
  if (!v.bars.some((b) => b.segments.length))
    return <div className="empty">No workspace closed in this range.</div>;
  return (
    <>
      <div className="xlabels">
        <span>{v.yMax}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        height={H}
        role="img"
        aria-label="Closed workspaces per bucket, shipped and abandoned"
      >
        {v.bars.flatMap((b) =>
          b.segments.map((s) => (
            <rect
              key={`${b.label}${s.key}`}
              x={b.x}
              y={s.y}
              width={b.width}
              height={s.height}
              fill={STACK_FILL[s.key]}
            >
              <title>{`${b.label}: ${s.value} ${s.key}`}</title>
            </rect>
          )),
        )}
      </svg>
      <XLabels cols={bars.map((b) => b.label)} />
    </>
  );
}

function Heatmap({
  rows,
  cols,
  grid,
}: {
  rows: string[];
  cols: string[];
  grid: (number | null)[][];
}) {
  if (!rows.length) return <div className="empty">No stage finished in this range.</div>;
  const h = rows.length * 22;
  const v = heatmapView(rows, cols, grid, h);
  return (
    <>
      <div className="plot">
        <div className="ylabels" aria-hidden="true" style={{ height: h }}>
          {rows.map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${W} ${h}`}
          preserveAspectRatio="none"
          height={h}
          role="img"
          aria-label="p50 minutes per ICM stage per bucket"
        >
          {v.cells.map((c) => (
            <rect
              key={`${c.row}${c.col}`}
              x={c.x}
              y={c.y}
              width={c.width}
              height={c.height}
              fill={c.intensity === null ? "var(--sd-hover)" : "var(--sd-accent)"}
              fillOpacity={c.intensity === null ? 1 : 0.12 + 0.88 * c.intensity}
              stroke="var(--sd-card)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${c.row}, ${c.col}: ${formatMinutes(c.value)}`}</title>
            </rect>
          ))}
        </svg>
      </div>
      <XLabels cols={cols} />
    </>
  );
}

export function MetricsTab({ bridge }: { bridge: HostBridge }) {
  const [range, setRange] = useState<MetricsRange>("30d");
  const [version, setVersion] = useState("all");
  const [trends, setTrends] = useState<MetricsTrends | null>(null);
  const [status, setStatus] = useState({ text: "Loading…", err: false });
  // Only range re-queries: version filters the rows' byVersion locally (SW-1098 Q1).
  useEffect(() => {
    let stale = false;
    setStatus({ text: "Loading…", err: false });
    (
      bridge.callTool("metrics-trends", {
        range,
        bucket: RANGE_BUCKET[range],
      }) as Promise<MetricsTrends>
    ).then(
      (t) => {
        if (stale) return;
        setTrends(t);
        setStatus({ text: "", err: false });
      },
      (e: Error) =>
        !stale && setStatus({ text: `Couldn't load the metrics: ${e.message}`, err: true }),
    );
    return () => {
      stale = true;
    };
  }, [bridge, range]);

  const versions = trends ? versionsOf(trends) : [];
  if (version !== "all" && !versions.includes(version)) versions.push(version);
  const rows = trends ? sliceRows(trends, version) : [];
  const charts = previewCharts(rows);

  return (
    <div className="metrics">
      <Css id="wsd-metrics" css={CSS} />
      <div className="controls">
        <fieldset className="ranges" aria-label="Range">
          {RANGES.map(([r, label]) => (
            <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
              {label}
            </button>
          ))}
        </fieldset>
        <select aria-label="Version" value={version} onChange={(e) => setVersion(e.target.value)}>
          <option value="all">All versions</option>
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className={status.err ? "load-status err" : "load-status"}>{status.text}</div>
      {trends && isEmpty(rows) && <div className="empty">{emptyText(range, version)}</div>}
      {trends && !isEmpty(rows) && (
        <>
          <div className="tiles">
            {metricsTiles(rows).map((t) => (
              <div key={t.label} className="tile">
                <div className="l">{t.label}</div>
                <div className="v">{t.value}</div>
                {t.sub && <div className="s">{t.sub}</div>}
              </div>
            ))}
          </div>
          <Chart title="Lead time to merge (p50 / p90)">
            <LineBand points={charts.lead} />
          </Chart>
          <Chart title="Closed workspaces (shipped / abandoned)">
            <StackedBars bars={charts.closed} keys={charts.closedKeys} />
          </Chart>
          <Chart title="Minutes per stage (p50)">
            <Heatmap {...charts.stages} />
          </Chart>
        </>
      )}
    </div>
  );
}
