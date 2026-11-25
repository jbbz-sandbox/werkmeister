/**
 * "Metrics" dashboard tab (SW-1098): the `metrics-trends` series over a range, filtered by
 * werkmeister version, drawn with the inline-SVG primitives in lib/charts.ts. SW-1099 adds stage
 * and ticket time; the closed-workspaces chart stays a preview until SW-1100/1101.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { MetricsRange, MetricsTrends } from "werkmeister-core/metrics_report";
import { Css } from "werkmeister-ui/theme";
import type { HostBridge } from "werkmeister-ui/workspace-ui";
import { heatmapView, multiLineView, type StackBar, stackedBarView, W } from "./lib/charts.js";
import { formatMinutes, RANGES } from "./lib/flow-board.js";
import {
  bottleneck,
  emptyText,
  isEmpty,
  leadTrend,
  metricsTiles,
  type Pct,
  previewCharts,
  RANGE_BUCKET,
  type SlicedRow,
  sliceRows,
  slowestTickets,
  stageHeatmap,
  stageTrend,
  type TrendLines,
  versionsOf,
  waitSplit,
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
  .metrics .chart h3 .ranges { display: inline-flex; margin-left: 8px; vertical-align: middle; }
  .metrics .chart h3 .ranges button { padding: 2px 8px; font-size: 12px; }
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
  .metrics .chart svg { width: 100%; display: block; }
  .metrics .xlabels { display: flex; justify-content: space-between; font-size: 11px; color: var(--sd-muted); margin-top: 2px; }
  .metrics .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--sd-muted); margin-top: 6px; }
  .metrics .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .metrics .bottleneck { font-size: 14px; font-weight: 600; margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; background: var(--sd-warn-bg); border: 1px solid var(--sd-warn-bd); }
  .metrics .heat { overflow-x: auto; }
  .metrics .heat table { border-collapse: separate; border-spacing: 2px; width: 100%; font-size: 11px; }
  .metrics .heat th { font-weight: 500; color: var(--sd-muted); text-align: left; white-space: nowrap; padding: 0 4px; }
  .metrics .heat th.flag { color: var(--sd-ink); font-weight: 700; }
  .metrics .heat td { height: 24px; min-width: 18px; text-align: center; border-radius: 3px; color: var(--sd-ink); }
  @media (max-width: 599px) { .metrics .heat td span { display: none; } }
  .metrics .split { display: grid; grid-template-columns: max-content 1fr; gap: 6px 8px; align-items: center; font-size: 12px; }
  .metrics .split .bar { display: flex; height: 14px; border-radius: 3px; overflow: hidden; }
  .metrics .split .lab { color: var(--sd-muted); grid-column: 2; margin-top: -4px; }
  .metrics .slow { list-style: none; margin: 8px 0 0; padding: 0; font-size: 13px; }
  .metrics .slow li { padding: 4px 0; border-top: 1px solid var(--sd-line-soft); }
  .metrics .slow a { color: var(--sd-accent); font-weight: 600; }
  .metrics .slow .ws { color: var(--sd-muted); margin-left: 6px; overflow-wrap: anywhere; }
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

function Chart({
  title,
  preview,
  children,
}: {
  title: ReactNode;
  preview?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="chart">
      <h3>{title}</h3>
      {preview && <div className="cap">Preview — replaced by SW-1100–1101</div>}
      {children}
    </section>
  );
}

function PctToggle({ value, onChange }: { value: Pct; onChange: (p: Pct) => void }) {
  return (
    <fieldset className="ranges" aria-label="Percentile">
      {(["p50", "p90"] as const).map((p) => (
        <button key={p} type="button" aria-pressed={p === value} onClick={() => onChange(p)}>
          {p}
        </button>
      ))}
    </fieldset>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="legend">
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function Lines({
  trend,
  colors,
  label,
  p,
  empty,
}: {
  trend: TrendLines;
  /** One colour per series, in series order. */
  colors: string[];
  label: string;
  p: Pct;
  empty: string;
}) {
  const v = multiLineView(trend.series, H);
  if (!v.lines.some((l) => l.dots.length)) return <div className="empty">{empty}</div>;
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
        aria-label={label}
      >
        {v.lines.map((l, si) => (
          <g key={l.key} stroke={colors[si % colors.length]}>
            <path d={l.d} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            {l.dots.map((d) => (
              // A zero-length round-capped stroke stays a circle under preserveAspectRatio="none".
              <path
                key={d.slot}
                d={`M${d.x} ${d.y} h0`}
                strokeWidth={8}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${l.key}, ${trend.cols[d.slot]}: ${p} ${formatMinutes(d.value)} (n ${trend.series[si].counts[d.slot]})`}</title>
              </path>
            ))}
          </g>
        ))}
      </svg>
      <XLabels cols={trend.cols} />
      <Legend items={trend.series.map((s, i) => [s.key, colors[i % colors.length]])} />
    </>
  );
}

// By position in the stages present, so stages of every pipeline (01_reproduce, 02_fix, …) differ.
// `--sd-info` is left out: it equals `--sd-accent` in light mode.
// shortcut: a stage's colour shifts with the stages present in the range and version, and repeats
// past 6; key by stage name if that confuses.
const STAGE_COLORS = [
  "var(--sd-ok)",
  "var(--sd-pr)",
  "var(--sd-accent)",
  "var(--sd-warn)",
  "var(--sd-err)",
  "var(--sd-muted)",
];
const LEAD_COLORS = ["var(--sd-accent)", "var(--sd-ok)"];
const SPLIT: [key: "person" | "capacity" | "working", label: string, color: string][] = [
  ["person", "Waiting on a person", "var(--sd-warn)"],
  ["capacity", "Waiting on capacity", "var(--sd-pr)"],
  ["working", "Working", "var(--sd-accent)"],
];

function StageTrendChart({ rows }: { rows: SlicedRow[] }) {
  const [p, setP] = useState<Pct>("p50");
  return (
    <Chart
      title={
        <>
          Stage time per bucket
          <PctToggle value={p} onChange={setP} />
        </>
      }
    >
      <Lines
        trend={stageTrend(rows, p)}
        colors={STAGE_COLORS}
        p={p}
        label={`${p} minutes per ICM stage per bucket, one line per stage`}
        empty="No stage finished in this range."
      />
    </Chart>
  );
}

function LeadChart({ rows }: { rows: SlicedRow[] }) {
  const [p, setP] = useState<Pct>("p50");
  const slow = slowestTickets(rows);
  return (
    <Chart
      title={
        <>
          Ticket lead time, from the first turn
          <PctToggle value={p} onChange={setP} />
        </>
      }
    >
      <Lines
        trend={leadTrend(rows, p)}
        colors={LEAD_COLORS}
        p={p}
        label={`${p} lead time per bucket, to merge and to release`}
        empty="No merges in this range."
      />
      {slow.length > 0 && (
        <>
          <div className="cap">Slowest tickets: open one's Flow timeline</div>
          <ol className="slow">
            {slow.map((t) => (
              <li key={t.workspace}>
                <a href={`#flow/${encodeURIComponent(t.workspace)}`}>{t.ticket}</a>{" "}
                {formatMinutes(t.leadToReleaseMinutes ?? t.leadToMergeMinutes)}{" "}
                {t.leadToReleaseMinutes === null ? "to merge" : "to release"}
                {t.ticket !== t.workspace && <span className="ws">{t.workspace}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Chart>
  );
}

function Heatmap({ rows, flagged }: { rows: SlicedRow[]; flagged: string | null }) {
  const h = stageHeatmap(rows);
  if (!h.rows.length) return <div className="empty">No stage finished in this range.</div>;
  // Cell geometry is unused: an HTML table keeps printed minutes from stretching with the SVG.
  const cells = heatmapView(h.rows, h.cols, h.grid, 1).cells;
  return (
    <div className="heat">
      <table>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            {h.cols.map((c, i) => (
              <th key={c} scope="col">
                {i === 0 || i === h.cols.length - 1 ? c.slice(5) : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {h.rows.map((r, ri) => (
            <tr key={r}>
              <th scope="row" className={r === flagged ? "flag" : undefined}>
                {r}
                {r === flagged && " · bottleneck"}
              </th>
              {h.cols.map((c, ci) => {
                const cell = cells[ri * h.cols.length + ci];
                const text = `${r}, ${c}: p50 ${formatMinutes(cell.value)}`;
                return (
                  <td
                    key={c}
                    title={text}
                    aria-label={text}
                    style={{
                      background:
                        cell.intensity === null
                          ? "var(--sd-hover)"
                          : `color-mix(in srgb, var(--sd-accent) ${Math.round(12 + 88 * cell.intensity)}%, transparent)`,
                      // Past half strength the fill is near solid accent: ink on it is unreadable.
                      ...((cell.intensity ?? 0) > 0.5 && { color: "var(--sd-on-accent)" }),
                    }}
                  >
                    {cell.value !== null && <span>{formatMinutes(cell.value)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SplitBars({ rows }: { rows: SlicedRow[] }) {
  const split = waitSplit(rows);
  const longest = Math.max(1, ...split.map((s) => s.total));
  if (!split.length) return <div className="empty">No stage finished in this range.</div>;
  return (
    <>
      <div className="split">
        {split.map((s) => {
          const waiting = s.person + s.capacity;
          return (
            <div key={s.stage} style={{ display: "contents" }}>
              <span>{s.stage}</span>
              <div
                className="bar"
                role="img"
                aria-label={`${s.stage}: ${formatMinutes(s.person)} waiting on a person, ${formatMinutes(s.capacity)} on capacity, ${formatMinutes(s.working)} working`}
                style={{ width: `${(s.total / longest) * 100}%` }}
              >
                {SPLIT.map(([k, label, color]) =>
                  s[k] > 0 ? (
                    <i
                      key={k}
                      title={`${label}: ${formatMinutes(s[k])}`}
                      style={{ flex: s[k], background: color }}
                    />
                  ) : null,
                )}
              </div>
              <span className="lab">
                {formatMinutes(s.total)} ·{" "}
                {s.total ? Math.round((Math.min(waiting, s.total) / s.total) * 100) : 0}% waiting
              </span>
            </div>
          );
        })}
      </div>
      <Legend items={SPLIT.map(([, label, color]) => [label, color])} />
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

export function MetricsTab({ bridge, active }: { bridge: HostBridge; active: boolean }) {
  const [range, setRange] = useState<MetricsRange>("30d");
  const [version, setVersion] = useState("all");
  const [trends, setTrends] = useState<MetricsTrends | null>(null);
  const [status, setStatus] = useState({ text: "Loading…", err: false });
  // Range and showing the tab re-query: version filters the rows' byVersion locally (SW-1098 Q1);
  // a hidden tab makes no call, so a run that closed meanwhile shows when it is opened (SW-1142).
  useEffect(() => {
    if (!active) return;
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
  }, [bridge, range, active]);

  const versions = trends ? versionsOf(trends) : [];
  if (version !== "all" && !versions.includes(version)) versions.push(version);
  const rows = trends ? sliceRows(trends, version) : [];
  const charts = previewCharts(rows);
  const flag = bottleneck(rows);

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
          {flag && (
            <p className="bottleneck" role="status">
              Bottleneck · {flag.text}
            </p>
          )}
          <StageTrendChart rows={rows} />
          <Chart title="Minutes per stage (p50)">
            <Heatmap rows={rows} flagged={flag?.stage ?? null} />
          </Chart>
          <Chart title="Waiting vs working per stage">
            <SplitBars rows={rows} />
          </Chart>
          <LeadChart rows={rows} />
          <Chart title="Closed workspaces (shipped / abandoned)" preview>
            <StackedBars bars={charts.closed} keys={charts.closedKeys} />
          </Chart>
        </>
      )}
    </div>
  );
}
