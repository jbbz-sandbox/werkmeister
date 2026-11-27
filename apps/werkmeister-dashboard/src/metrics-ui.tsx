/**
 * "Metrics" dashboard tab (SW-1098): the `metrics-trends` series over a range, filtered by
 * werkmeister version, drawn with the inline-SVG primitives in lib/charts.ts. SW-1099 adds stage
 * and ticket time, SW-1101 gate and test time, SW-1100 tokens and cost.
 */

import { type ReactNode, useEffect, useState } from "react";
import type { CostlyTicket, MetricsRange, MetricsTrends } from "werkmeister-core/metrics_report";
import { Css } from "werkmeister-ui/theme";
import type { HostBridge } from "werkmeister-ui/workspace-ui";
import {
  formatUsd,
  heatmapView,
  multiLineView,
  type StackBar,
  stackedBarView,
  W,
} from "./lib/charts.js";
import { formatCount, formatMinutes, RANGES } from "./lib/flow-board.js";
import {
  AFTER_STAGES,
  bottleneck,
  cacheShareLine,
  costliestTickets,
  emptyText,
  firstPassLine,
  formatTestMinutes,
  GATE_KINDS,
  gateKindBars,
  isEmpty,
  leadTrend,
  MODEL_FAMILIES,
  metricsTiles,
  modelBars,
  type Pct,
  priceNote,
  RANGE_BUCKET,
  type SlicedRow,
  type SlowSuite,
  sliceRows,
  slowestSuites,
  slowestTickets,
  stageHeatmap,
  stageTokenBars,
  stageTrend,
  type TokenMode,
  type TrendLines,
  testRegression,
  testTrend,
  ticketCostLines,
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
  .metrics .suites { width: 100%; border-collapse: collapse; font-size: 12px; }
  .metrics .suites th, .metrics .suites td { text-align: left; padding: 4px 6px; border-top: 1px solid var(--sd-line-soft); white-space: nowrap; }
  .metrics .suites thead th { color: var(--sd-muted); font-weight: 500; border-top: 0; }
  .metrics .suites td:nth-child(4) { width: 40%; }
  .metrics .suites tr.warn { background: var(--sd-warn-bg); }
  .metrics .suites .tag { margin-left: 6px; font-size: 11px; font-weight: 700; color: var(--sd-ink); border: 1px solid var(--sd-warn-bd); border-radius: 4px; padding: 0 4px; }
  @media (max-width: 599px) { .metrics .suites th:nth-child(3), .metrics .suites td:nth-child(3) { display: none; } }
  .metrics .suites.costly th:nth-child(3), .metrics .suites.costly td:nth-child(3) { display: table-cell; }
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

function Chart({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="chart">
      <h3>{title}</h3>
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
  fmt = formatMinutes,
}: {
  trend: TrendLines;
  /** One colour per series, in series order. */
  colors: string[];
  label: string;
  p?: Pct;
  empty: string;
  fmt?: (n: number) => string;
}) {
  const v = multiLineView(trend.series, H);
  if (!v.lines.some((l) => l.dots.length)) return <div className="empty">{empty}</div>;
  return (
    <>
      <div className="xlabels">
        <span>{fmt(v.yMax)}</span>
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
                <title>{`${l.key}, ${trend.cols[d.slot]}: ${p ? `${p} ` : ""}${fmt(d.value)} (n ${trend.series[si].counts[d.slot]})`}</title>
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
                {t.leadToReleaseMinutes == null ? "to merge" : "to release"}
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
          // Person and capacity waits can overlap; scale them into `waiting` so the bar sums to the stage.
          const both = s.person + s.capacity;
          const scale = both > s.waiting ? s.waiting / both : 1;
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
                      style={{ flex: k === "working" ? s[k] : s[k] * scale, background: color }}
                    />
                  ) : null,
                )}
              </div>
              <span className="lab">
                {formatMinutes(s.total)} · {s.total ? Math.round((s.waiting / s.total) * 100) : 0}%
                waiting
              </span>
            </div>
          );
        })}
      </div>
      <Legend items={SPLIT.map(([, label, color]) => [label, color])} />
    </>
  );
}

function StackedBars({
  bars,
  keys,
  fill,
  label,
  empty,
  fmt = String,
}: {
  bars: StackBar[];
  keys: string[];
  fill: Record<string, string>;
  label: string;
  empty: string;
  fmt?: (n: number) => string;
}) {
  const v = stackedBarView(bars, keys, H);
  if (!v.bars.some((b) => b.segments.length)) return <div className="empty">{empty}</div>;
  return (
    <>
      <div className="xlabels">
        <span>{fmt(v.yMax)}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        height={H}
        role="img"
        aria-label={label}
      >
        {v.bars.flatMap((b) =>
          b.segments.map((s) => (
            <rect
              key={`${b.label}${s.key}`}
              x={b.x}
              y={s.y}
              width={b.width}
              height={s.height}
              fill={fill[s.key]}
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

// Row kinds and suites take the stage palette by position, as stages do.
const GATE_FILL: Record<string, string> = Object.fromEntries(
  GATE_KINDS.map((k, i) => [k, STAGE_COLORS[i % STAGE_COLORS.length]]),
);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function TestTrendChart({ rows }: { rows: SlicedRow[] }) {
  const [p, setP] = useState<Pct>("p50");
  return (
    <Chart
      title={
        <>
          Test time per package
          <PctToggle value={p} onChange={setP} />
        </>
      }
    >
      <Lines
        trend={testTrend(rows, p)}
        colors={STAGE_COLORS}
        p={p}
        fmt={formatTestMinutes}
        label={`${p} test minutes per package per bucket, one line per package`}
        empty="No test run in this range."
      />
    </Chart>
  );
}

const SPARK_H = 24;

function Spark({ values, warn }: { values: (number | null)[]; warn: boolean }) {
  const line = multiLineView([{ key: "p50", values }], SPARK_H).lines[0];
  return (
    <svg
      viewBox={`0 0 ${W} ${SPARK_H}`}
      preserveAspectRatio="none"
      height={SPARK_H}
      aria-hidden="true"
      style={{ width: "100%", minWidth: 60 }}
    >
      <path
        d={line?.d ?? ""}
        fill="none"
        stroke={warn ? "var(--sd-warn)" : "var(--sd-accent)"}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SlowSuites({ suites }: { suites: SlowSuite[] }) {
  if (!suites.length) return <div className="empty">No test run in this range.</div>;
  return (
    <table className="suites">
      <thead>
        <tr>
          <th scope="col">Package</th>
          <th scope="col">p90</th>
          <th scope="col">Runs</th>
          <th scope="col">p50 trend</th>
          <th scope="col">Latest p50</th>
        </tr>
      </thead>
      <tbody>
        {suites.map((s) => (
          <tr key={s.package} className={s.slow ? "warn" : undefined}>
            <th scope="row">
              {s.package}
              {s.slow && <span className="tag">slow</span>}
            </th>
            <td>{formatTestMinutes(s.p90Minutes)}</td>
            <td>{s.runs}</td>
            <td>
              <Spark values={s.spark} warn={s.slow} />
            </td>
            <td>{formatTestMinutes(s.latestP50)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** SW-1101: gate minutes by row kind, test time per package, the slowest suites and the first-pass rate. */
function GateSection({
  trends,
  rows,
  version,
}: {
  trends: MetricsTrends;
  rows: SlicedRow[];
  version: string;
}) {
  const regression = testRegression(trends, rows);
  return (
    <>
      {regression && (
        <p className="bottleneck" role="status">
          Regression · {regression.text}
        </p>
      )}
      <Chart title="Gate minutes by row kind">
        <StackedBars
          bars={gateKindBars(rows)}
          keys={[...GATE_KINDS]}
          fill={GATE_FILL}
          fmt={formatTestMinutes}
          label="Gate minutes per bucket, stacked by row kind"
          empty="No gate rows in this range."
        />
        <Legend items={GATE_KINDS.map((k) => [k, GATE_FILL[k]])} />
      </Chart>
      <TestTrendChart rows={rows} />
      <Chart title="Slowest suites (by p90 over the range)">
        <SlowSuites suites={slowestSuites(trends, rows, version)} />
      </Chart>
      <Chart title="Gate first-pass rate">
        <Lines
          trend={firstPassLine(rows)}
          colors={["var(--sd-ok)"]}
          fmt={pct}
          label="Share of workspaces whose first gate run passed, per bucket"
          empty="No first gate run in this range."
        />
      </Chart>
    </>
  );
}

const MODEL_FILL: Record<string, string> = {
  Opus: "var(--sd-accent)",
  Sonnet: "var(--sd-ok)",
  Haiku: "var(--sd-warn)",
  Fable: "var(--sd-pr)",
  Other: "var(--sd-muted)",
};

function ModeToggle({ value, onChange }: { value: TokenMode; onChange: (m: TokenMode) => void }) {
  return (
    <fieldset className="ranges" aria-label="Tokens or cost">
      {(["tokens", "cost"] as const).map((m) => (
        <button key={m} type="button" aria-pressed={m === value} onClick={() => onChange(m)}>
          {m === "tokens" ? "Tokens" : "Cost"}
        </button>
      ))}
    </fieldset>
  );
}

const Note = ({ text }: { text: string | undefined }) =>
  text ? <div className="cap">{text}</div> : null;

function CostliestTickets({ tickets }: { tickets: CostlyTicket[] }) {
  if (!tickets.length) return <div className="empty">No ticket shipped in this range.</div>;
  return (
    <table className="suites costly">
      <thead>
        <tr>
          <th scope="col">Ticket</th>
          <th scope="col">Tokens</th>
          <th scope="col">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => (
          <tr key={t.ticket}>
            <th scope="row">{t.ticket}</th>
            <td>{formatCount(t.tokens)}</td>
            <td>{t.estUsd === null ? "—" : formatUsd(t.estUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** SW-1100: tokens and cost by model, cache-read share, per-ticket cost and tokens per stage. */
function TokenSection({ rows }: { rows: SlicedRow[] }) {
  const [modelMode, setModelMode] = useState<TokenMode>("tokens");
  const [ticketMode, setTicketMode] = useState<TokenMode>("cost");
  const fmtOf = (m: TokenMode) => (m === "tokens" ? formatCount : formatUsd);
  const unpriced = priceNote(rows.reduce((a, r) => a + (r.slice?.costUnknown ?? 0), 0));
  const unpricedTickets = priceNote(
    rows.reduce((a, r) => a + (r.slice?.perTicket.unpriced ?? 0), 0),
  );
  const perStage = stageTokenBars(rows);
  const stageFill: Record<string, string> = Object.fromEntries(
    perStage.keys.map((k, i) => [
      k,
      k === AFTER_STAGES ? "var(--sd-muted)" : STAGE_COLORS[i % STAGE_COLORS.length],
    ]),
  );
  const ticketLines = ticketCostLines(rows, ticketMode);
  return (
    <>
      <Chart
        title={
          <>
            {modelMode === "tokens" ? "Tokens" : "Est. cost"} by model
            <ModeToggle value={modelMode} onChange={setModelMode} />
          </>
        }
      >
        <StackedBars
          bars={modelBars(rows, modelMode)}
          keys={[...MODEL_FAMILIES]}
          fill={MODEL_FILL}
          fmt={fmtOf(modelMode)}
          label={`${modelMode === "tokens" ? "Tokens" : "Estimated cost"} per bucket, stacked by model family`}
          empty="No workspace closed in this range."
        />
        <Legend items={MODEL_FAMILIES.map((f) => [f, MODEL_FILL[f]])} />
        {modelMode === "cost" && <Note text={unpriced} />}
      </Chart>
      <Chart title="Cache-read share of input (higher is cheaper)">
        <Lines
          trend={cacheShareLine(rows)}
          colors={["var(--sd-ok)"]}
          fmt={pct}
          label="Cache reads as a share of input tokens, per bucket"
          empty="No workspace closed in this range."
        />
      </Chart>
      <Chart
        title={
          <>
            {ticketMode === "tokens" ? "Tokens" : "Est. cost"} per shipped ticket
            <ModeToggle value={ticketMode} onChange={setTicketMode} />
          </>
        }
      >
        <Lines
          trend={ticketLines}
          colors={LEAD_COLORS}
          fmt={fmtOf(ticketMode)}
          label={`p50 and p90 ${ticketMode === "tokens" ? "tokens" : "estimated cost"} per shipped ticket, per bucket`}
          empty="No ticket shipped in this range."
        />
        {ticketMode === "cost" && <Note text={unpricedTickets} />}
      </Chart>
      <Chart title="Costliest tickets">
        <CostliestTickets tickets={costliestTickets(rows)} />
      </Chart>
      <Chart title="Tokens per stage">
        <StackedBars
          bars={perStage.bars}
          keys={perStage.keys}
          fill={stageFill}
          fmt={formatCount}
          label="Summed tokens per ICM stage over the range, and after the last stage"
          empty="No stage tokens in this range (runs closed before SW-1100 have none)."
        />
        <Legend items={perStage.keys.map((k) => [k, stageFill[k]])} />
      </Chart>
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
          <GateSection trends={trends} rows={rows} version={version} />
          <TokenSection rows={rows} />
        </>
      )}
    </div>
  );
}
