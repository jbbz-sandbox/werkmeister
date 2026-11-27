/**
 * The Flow tab's view model (SW-782, SW-783, design SW-772 § Q1, § Q5): card text, the red card,
 * the workspace timeline's bars, and the chart and tile inputs, from the `metrics` tool's report.
 * Pure, so the smoke test needs no DOM.
 */
import type {
  FlowCard,
  FlowColumn,
  MetricsRange,
  MetricsReport,
  TimelineEvent,
  WaitCause,
} from "werkmeister-core/metrics_report";
import { formatUsd, type StackBar, type StatTile, statTile } from "./charts.js";

/** The Flow and Metrics tabs' range buttons. */
export const RANGES: [MetricsRange, string][] = [
  ["7d", "7d"],
  ["30d", "30d"],
  ["90d", "90d"],
  ["all", "All"],
];

export const COLUMN_LABEL: Record<FlowColumn, string> = {
  working: "Working",
  ready: "Ready",
  "pr-open": "PR open",
  "awaiting-release": "Awaiting release",
};
export const WAIT_LABEL: Record<WaitCause, string> = {
  person: "on you",
  capacity: "capacity",
  pr: "PR/CI",
  gateRetry: "gate retry",
  release: "release",
};

/** The work types the selectors offer before a report lists the ones in use. */
export const WORK_TYPES = ["feature", "bugfix", "refactor", "spike", "incident", "unknown"];
// `--sd-err` stays the past-p90 colour and `--sd-info` equals accent in light mode, so neither is a type.
const WORK_TYPE_FILL: Record<string, string> = {
  feature: "var(--sd-accent)",
  bugfix: "var(--sd-ok)",
  refactor: "var(--sd-pr)",
  spike: "var(--sd-warn)",
  incident: "var(--sd-muted)",
};
/** A work type's dot colour; a workflow type or `unknown` is faint. */
export const workTypeFill = (t: string) => WORK_TYPE_FILL[t] ?? "var(--sd-faint)";
export const COLUMN_FILL: Record<FlowColumn, string> = {
  working: "var(--sd-accent)",
  ready: "var(--sd-ok)",
  "pr-open": "var(--sd-pr)",
  "awaiting-release": "var(--sd-warn)",
};

/** One "where the time goes" bar: a work type's column medians, from the report's `byWorkType` (SW-1212). */
export interface TimeGoesBar extends StackBar {
  n: number;
  faded: boolean;
  sumOfMedians: number;
  tips: Record<string, { p50: number | null; p90: number | null; count: number }>;
}

/** A bar per work type with a run that finished in range, its segments the column p50s in flow order. */
export function timeGoesBars(r: MetricsReport): TimeGoesBar[] {
  return Object.entries(r.byWorkType)
    .filter(([, s]) => s.runs > 0)
    .map(([type, s]) => ({
      label: type,
      values: Object.fromEntries(s.columns.map((c) => [c.column, c.p50Minutes ?? 0])),
      n: s.runs,
      faded: s.fewRuns,
      sumOfMedians: s.sumOfMediansMinutes,
      tips: Object.fromEntries(
        s.columns.map((c) => [c.column, { p50: c.p50Minutes, p90: c.p90Minutes, count: c.count }]),
      ),
    }));
}

/** `42m`, `3h 5m`, `2d 4h`; `—` when unknown. */
export function formatMinutes(m: number | null): string {
  if (m === null) return "—";
  const r = Math.round(m);
  if (r < 60) return `${r}m`;
  if (r < 1440) return `${Math.floor(r / 60)}h ${r % 60}m`;
  return `${Math.floor(r / 1440)}d ${Math.floor((r % 1440) / 60)}h`;
}

export interface CardView {
  title: string;
  stage: string | null;
  age: string;
  badge: string | null;
  red: boolean;
  /** Red against the pooled p90: its work type has too few runs for its own. */
  pooled: boolean;
}

export function cardView(c: FlowCard): CardView {
  return {
    title: c.ticket ?? c.workspace,
    stage: c.stage ? `${String(c.stage.index).padStart(2, "0")} ${c.stage.name}` : null,
    age: formatMinutes(c.ageMinutes),
    badge: c.wait ? `${WAIT_LABEL[c.wait.cause]} · ${Math.round(c.wait.minutes)} min` : null,
    red: c.overP90,
    pooled: c.overP90 && c.p90Pooled,
  };
}

export interface TimelineBar {
  kind: "stage" | "wait" | "gate" | "pr";
  /** ms since the epoch; a point when `from === to`. */
  from: number;
  to: number;
  label: string;
  fail?: boolean;
}

/** The timeline's span and bars: stages, wait blocks, gate runs and PR points. */
export function timelineView(
  events: TimelineEvent[],
  now: Date,
): { start: number; end: number; bars: TimelineBar[] } {
  const bars: TimelineBar[] = [];
  const t = (e: TimelineEvent) => Date.parse(e.at);
  let stageFrom = events.length ? t(events[0]) : now.getTime();
  let gateFrom: number | null = null;
  let askFrom: number | null = null;
  let queueFrom: number | null = null;
  let prOpened = false;
  for (const e of events) {
    const at = t(e);
    switch (e.event) {
      case "stage.done":
        bars.push({ kind: "stage", from: stageFrom, to: at, label: e.stage ?? "stage" });
        stageFrom = at;
        break;
      case "ask":
        askFrom ??= at;
        break;
      case "queue.wait":
        queueFrom ??= at;
        break;
      case "answer":
      case "queue.admit":
        if (e.event === "answer") askFrom = null;
        else queueFrom = null;
        if (e.waitedS)
          bars.push({
            kind: "wait",
            from: at - e.waitedS * 1000,
            to: at,
            label: e.event === "answer" ? WAIT_LABEL.person : WAIT_LABEL.capacity,
          });
        break;
      case "gate.start":
        gateFrom = at;
        break;
      case "gate.end":
        if (gateFrom !== null) {
          const label = e.exit === 0 ? "gate pass" : e.exit === 75 ? "gate retry" : "gate fail";
          bars.push({ kind: "gate", from: gateFrom, to: at, label, fail: e.exit !== 0 });
          gateFrom = null;
        }
        break;
      case "pr.open":
      case "pr.merged":
      case "release":
        prOpened = true;
        bars.push({ kind: "pr", from: at, to: at, label: e.event });
        break;
    }
  }
  const n = now.getTime();
  // Still open now: the stage being worked (until a PR opens), a gate run, an unanswered ask or queue wait.
  if (!prOpened && events.length)
    bars.push({ kind: "stage", from: stageFrom, to: n, label: "current stage" });
  if (gateFrom !== null) bars.push({ kind: "gate", from: gateFrom, to: n, label: "gate running" });
  if (askFrom !== null) bars.push({ kind: "wait", from: askFrom, to: n, label: WAIT_LABEL.person });
  if (queueFrom !== null)
    bars.push({ kind: "wait", from: queueFrom, to: n, label: WAIT_LABEL.capacity });
  const start = Math.min(stageFrom, ...bars.map((b) => b.from));
  return { start, end: Math.max(now.getTime(), ...bars.map((b) => b.to)), bars };
}

/** Bottom-up stack order of the wait-by-cause bars and their legend. */
export const WAIT_KEYS: WaitCause[] = ["person", "capacity", "pr", "gateRetry", "release"];

/** One bar per ISO week, each cause in hours. */
export function waitBars(r: MetricsReport): StackBar[] {
  return r.waitsByWeek.map((w) => ({
    label: w.week,
    values: Object.fromEntries(WAIT_KEYS.map((k) => [k, w.seconds[k] / 3600])),
  }));
}

/** The scatter's dots (x = merge time) and p50/p90 lines for cycle time, x spanning the range. */
export function cyclePoints(r: MetricsReport) {
  const points = r.tickets.map((t) => ({
    t: Date.parse(t.mergedAt),
    value: t.cycleMinutes,
    label: t.ticket,
    workType: t.workType,
  }));
  const p = r.cycle;
  const x1 = Date.parse(r.to);
  const x0 = r.from ? Date.parse(r.from) : Math.min(x1, ...points.map((d) => d.t));
  return { points, p50: p.p50Minutes, p90: p.p90Minutes, x0, x1 };
}

/** `940`, `812k`, `56.4M`. */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Cost, tokens with cache-read share, active vs wall, and turns, over the range's closed runs. */
export function flowTiles(u: MetricsReport["usage"]): StatTile[] {
  const none = u.workspaces === 0;
  const closed = `${u.workspaces} workspace${u.workspaces === 1 ? "" : "s"} closed`;
  const tokens = u.tokens.input + u.tokens.output + u.tokens.cacheCreation + u.tokens.cacheRead;
  return [
    statTile(
      "Est. cost",
      u.estUsd,
      formatUsd,
      u.costUnknown ? `${closed} · ${u.costUnknown} unpriced` : closed,
    ),
    statTile(
      "Tokens",
      none ? null : tokens,
      formatCount,
      u.cacheReadShare === null ? undefined : `${pct(u.cacheReadShare)} cache-read`,
    ),
    {
      label: "Active / wall",
      value: none
        ? "—"
        : `${formatMinutes(u.activeMinutes)} / ${formatMinutes(u.wallClockMinutes)}`,
      ...(u.wallClockMinutes ? { sub: `${pct(u.activeMinutes / u.wallClockMinutes)} active` } : {}),
    },
    statTile("Turns", none ? null : u.turns, String, closed),
  ];
}

/** One bar per day of active agent minutes. */
export function agentBars(r: MetricsReport): StackBar[] {
  return r.agentByDay.map((d) => ({ label: d.day, values: { active: d.activeMinutes } }));
}
