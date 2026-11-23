/**
 * The Flow tab's view model (SW-782, design SW-772 § Q1, § Q5): card text, the red card, and the
 * workspace timeline's bars, from the `metrics` tool's report. Pure, so the smoke test needs no DOM.
 */
import type {
  FlowCard,
  FlowColumn,
  TimelineEvent,
  WaitCause,
} from "werkmeister-core/metrics_report";

/** The dashboard's tabs, in order, with their labels; the URL hash names one. */
export const TABS = [
  ["list", "Workspaces"],
  ["new", "New workspace"],
  ["prs", "Open Pull Requests"],
  ["health", "Health"],
  ["flow", "Flow"],
  ["links", "Links"],
] as const;
export type Tab = (typeof TABS)[number][0];
export const isTab = (h: string): h is Tab => TABS.some(([t]) => t === h);

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
