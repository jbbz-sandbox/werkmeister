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
}

export function cardView(c: FlowCard): CardView {
  return {
    title: c.ticket ?? c.workspace,
    stage: c.stage ? `${String(c.stage.index).padStart(2, "0")} ${c.stage.name}` : null,
    age: formatMinutes(c.ageMinutes),
    badge: c.wait ? `${WAIT_LABEL[c.wait.cause]} · ${Math.round(c.wait.minutes)} min` : null,
    red: c.overP90,
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

export type CycleMode = "cycle" | "lead";

/** The scatter's dots (x = merge time) and lines for cycle or lead time, x spanning the range. */
export function cyclePoints(r: MetricsReport, mode: CycleMode) {
  const points = r.tickets.map((t) => ({
    t: Date.parse(t.mergedAt),
    value: mode === "cycle" ? t.cycleMinutes : t.leadMinutes,
    label: t.ticket,
  }));
  const p = mode === "cycle" ? r.cycle : r.lead;
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
