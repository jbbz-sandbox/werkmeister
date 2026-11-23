/**
 * The `metrics` MCP tool's report (SW-781, design SW-772 § Q1, § Q5, § Definitions): the flow
 * board, waits by cause per week, cycle and lead time, and usage rollups over a range, from the
 * event log, `usage.json` snapshots and current workspace state.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { liveWaiting, sessionGone, sessionsDir } from "./agent_state.js";
import { getReposRoot, sandboxHome } from "./config.js";
import { WORKSPACE_ROOT_REPO } from "./machine_setup.js";
import { lifecycleOf } from "./pr_lifecycle.js";
import { warn } from "./reporter.js";
import {
  getWorkspaceUsage,
  type IcmStage,
  icmStage,
  listWorkspaces,
  type UsageTotals,
} from "./sandbox.js";
import type { UsageSnapshot } from "./usage_snapshot.js";

/** A `metrics` range: the last 7, 30 or 90 days, or everything logged. */
export type MetricsRange = "7d" | "30d" | "90d" | "all";
/** Every `MetricsRange`, in the order the Flow tab shows them. */
export const METRICS_RANGES: readonly MetricsRange[] = ["7d", "30d", "90d", "all"];
/** What work waited on: a person's answer, host capacity, PR open → merge, gate exit-75 retries, or a release. */
export type WaitCause = "person" | "capacity" | "pr" | "gateRetry" | "release";
/** A flow-board column: working (with its ICM stage), ready, pr-open, or merged and awaiting release. */
export type FlowColumn = "working" | "ready" | "pr-open" | "awaiting-release";
/** Seconds waited, per cause. */
export type WaitSeconds = Record<WaitCause, number>;

/** One open workspace on the flow board. */
export interface FlowCard {
  /** The workspace folder name. */
  workspace: string;
  /** Its tracker key, or null when it has none. */
  ticket: string | null;
  /** The ICM stage chip; working cards only. */
  stage: IcmStage | null;
  /** When the card entered its column, or null when nothing recorded it. */
  enteredAt: string | null;
  /** Minutes since `enteredAt`, or null when that is unknown. */
  ageMinutes: number | null;
  /** Older than the column's p90: the red card. */
  overP90: boolean;
  /** The wait open now, or null when nothing is waited on. */
  wait: {
    /** What it waits on. */
    cause: WaitCause;
    /** When the wait began. */
    since: string;
    /** Minutes waited so far. */
    minutes: number;
  } | null;
}
/** One flow-board column with its cards and its past age percentiles. */
export interface FlowColumnReport {
  /** Which column. */
  column: FlowColumn;
  /** Cards in it now. */
  wip: number;
  /** Median minutes of the column's completed visits that ended in the range, or null with none. */
  p50Minutes: number | null;
  /** 90th-percentile minutes of those visits, or null with none. */
  p90Minutes: number | null;
  /** Its open cards, oldest first. */
  cards: FlowCard[];
}
/** Cycle and lead time of one ticket whose PR merged in the range. */
export interface TicketTimes {
  /** The tracker key, or the workspace name when there is none. */
  ticket: string;
  /** The workspace folder name. */
  workspace: string;
  /** The workspace's first Claude turn, where lead starts, and cycle when `inProgressAt` is null. */
  firstTurn: string;
  /** The workspace's earliest `issue.start`, where cycle starts, or null with none. */
  inProgressAt: string | null;
  /** Its last PR merge. */
  mergedAt: string;
  /** Its last release, or null when the repo ships with no tag. */
  releasedAt: string | null;
  /** Minutes from `inProgressAt` (else the first turn) to the merge. */
  cycleMinutes: number;
  /** Minutes from the first turn to the release, or to the merge when the repo ships with no tag. */
  leadMinutes: number;
}
/** Nearest-rank percentiles, null with no values. */
export interface Percentiles {
  /** The median, in minutes. */
  p50Minutes: number | null;
  /** The 90th percentile, in minutes. */
  p90Minutes: number | null;
}
/**
 * What {@link metricsReport} returns.
 *
 * @example
 * ```ts
 * import { type MetricsReport, metricsReport } from "werkmeister-core/sdk";
 *
 * const report: MetricsReport = await metricsReport();
 * const stuck = report.board.flatMap((col) => col.cards.filter((c) => c.overP90));
 * console.log(stuck.map((c) => c.workspace));
 * ```
 */
export interface MetricsReport {
  /** The range asked for. */
  range: MetricsRange;
  /** The range's start, or null for `all`. */
  from: string | null;
  /** The range's end: now. */
  to: string;
  /** The four columns: working, ready, pr-open, awaiting-release. */
  board: FlowColumnReport[];
  /** ISO weeks (Monday, UTC) from the range's start to now, oldest first. */
  waitsByWeek: {
    /** The week's Monday, `YYYY-MM-DD`. */
    week: string;
    /** Seconds waited in it, by the week the wait ended. */
    seconds: WaitSeconds;
  }[];
  /** Seconds waited over the whole range. */
  waits: WaitSeconds;
  /** Tickets whose last PR merged in the range, oldest merge first. */
  tickets: TicketTimes[];
  /** Percentiles of `tickets` cycle minutes. */
  cycle: Percentiles;
  /** Percentiles of `tickets` lead minutes. */
  lead: Percentiles;
  /** Workspaces whose `usage.json` closedAt is in the range. */
  usage: {
    /** How many snapshots. */
    workspaces: number;
    /** Their summed estimated cost in USD, or null when none has one. */
    estUsd: number | null;
    /** Snapshots with no cost estimate. */
    costUnknown: number;
    /** Their summed tokens. */
    tokens: UsageTotals;
    /** Cache reads ÷ (input + cache creation + cache reads), or null with no input tokens. */
    cacheReadShare: number | null;
    /** Summed active minutes. */
    activeMinutes: number;
    /** Summed wall-clock minutes. */
    wallClockMinutes: number;
    /** Summed turns. */
    turns: number;
  };
  /** The asked-for workspace's current run, oldest first; only when `metricsReport` got a `workspace`. */
  timeline?: TimelineEvent[];
  /** Gate first-pass rate over workspaces whose first finished gate run (exit ≠ 75) ended in the range. */
  gate: {
    /** `passed ÷ workspaces`, or null with none. */
    firstPassRate: number | null;
    /** Workspaces whose first finished run exited 0. */
    passed: number;
    /** Workspaces with a finished run. */
    workspaces: number;
  };
}

/** One event of a workspace's current run, for its Flow timeline. */
export interface TimelineEvent {
  /** When it happened. */
  at: string;
  /** start (the run's first turn), stage.done, ask, answer, queue.wait, queue.admit, gate.start, gate.end, pr.open, pr.merged or release. */
  event: string;
  /** stage.done: the stage. */
  stage?: string;
  /** answer, queue.admit: seconds waited before `at`. */
  waitedS?: number;
  /** gate.end: the exit code (75 = retry later). */
  exit?: number;
  /** pr.open, pr.merged, release: the PR URL. */
  pr?: string;
}
const TIMELINE_EVENTS: readonly string[] = [
  "stage.done",
  "ask",
  "answer",
  "queue.wait",
  "queue.admit",
  "gate.start",
  "gate.end",
  "pr.open",
  "pr.merged",
  "release",
];

export interface OpenWorkspace {
  workspace: string;
  ticket: string | null;
  lifecycle: "working" | "ready" | "pr-open" | "merged";
  stage: IcmStage | null;
  firstTurn: string | null;
  /** The newest PR-file edit: when a ready card has no gate run yet, the approval. */
  prFileAt: string | null;
  /** The oldest open ask of a live session. */
  askAt: string | null;
  waitingSince: string | null;
}
export type UsageRow = Pick<
  UsageSnapshot,
  | "workspace"
  | "ticket"
  | "closedAt"
  | "firstTurn"
  | "estUsd"
  | "totals"
  | "activeMinutes"
  | "wallClockMinutes"
  | "turns"
>;
export interface FlowInput {
  events: Record<string, unknown>[];
  open: OpenWorkspace[];
  usages: UsageRow[];
}

const DAY_MS = 86_400_000;
const COLUMNS: FlowColumn[] = ["working", "ready", "pr-open", "awaiting-release"];
const COLUMN_OF: Record<OpenWorkspace["lifecycle"], FlowColumn> = {
  working: "working",
  ready: "ready",
  "pr-open": "pr-open",
  merged: "awaiting-release",
};
const ms = (t: string) => Date.parse(t);
const minutes = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 60_000);
const zeroWaits = (): WaitSeconds => ({ person: 0, capacity: 0, pr: 0, gateRetry: 0, release: 0 });

/** Nearest-rank percentile; null for no values. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? null;
}
const percentiles = (values: number[]): Percentiles => ({
  p50Minutes: percentile(values, 0.5),
  p90Minutes: percentile(values, 0.9),
});

/** The Monday (UTC) of *t*'s ISO week, as YYYY-MM-DD. */
function weekOf(t: number): string {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const min = (a: string | undefined, b: string) => (a === undefined || ms(b) < ms(a) ? b : a);
const max = (a: string | undefined, b: string) => (a === undefined || ms(b) > ms(a) ? b : a);

interface Timeline {
  ticket?: string;
  firstGateStart?: string;
  firstOpen?: string;
  lastMerged?: string;
  lastRelease?: string;
  /** The first gate.end with exit ≠ 75, the first-pass run. */
  firstFinished?: { at: string; exit: number };
}

/** Racing `pr watch` / `pr status` writers can log one `pr.open` / `pr.merged` / `release` twice (SW-997): keep the first per (event, pr). */
function firstPerPr(): (e: Record<string, unknown>) => boolean {
  const seen = new Set<string>();
  return (e) => {
    const pr = e["pr"];
    if (!["pr.open", "pr.merged", "release"].includes(String(e["event"])) || !pr) return true;
    const key = `${e["event"]}|${pr}`;
    return !seen.has(key) && !!seen.add(key);
  };
}

/** The report for *input* over *range*, as of *now*. Pure: the formulas of § Definitions. */
export function flowMetrics(
  input: FlowInput,
  range: MetricsRange,
  now: Date,
  workspace?: string,
): MetricsReport {
  const to = now.getTime();
  const from = range === "all" ? null : to - Number.parseInt(range, 10) * DAY_MS;
  const inRange = (t: string | undefined | null): t is string =>
    !!t && ms(t) <= to && (from === null || ms(t) >= from);

  // An open workspace's own run wins over a closed run of the same name.
  const firstTurn = new Map<string, string>();
  for (const u of input.usages) if (u.firstTurn) firstTurn.set(u.workspace, u.firstTurn);
  for (const o of input.open) if (o.firstTurn) firstTurn.set(o.workspace, o.firstTurn);
  // Events before this belong to another run: a closed run's first turn, or, for an open
  // workspace, the close-out of an earlier run of its name. Not the open run's first turn: its
  // oldest transcripts may be pruned, and its own early events must stay.
  const runStart = new Map<string, string>();
  for (const u of input.usages) if (u.firstTurn) runStart.set(u.workspace, u.firstTurn);
  for (const o of input.open) {
    const closed = input.usages
      .filter((u) => u.workspace === o.workspace)
      .reduce<string | undefined>((a, u) => max(a, u.closedAt), undefined);
    if (closed) runStart.set(o.workspace, closed);
    else runStart.delete(o.workspace);
  }

  const tl = new Map<string, Timeline>();
  const waitAt: { cause: WaitCause; at: string; s: number }[] = [];
  const opened = new Map<string, string>();
  const merged = new Map<string, string>();
  const released = new Map<string, string>();
  const gateStart = new Map<string, string>();
  const events = input.events
    .filter((e) => {
      const at = String(e["at"]);
      if (Number.isNaN(ms(at))) return false;
      // shortcut: events are keyed by workspace name; two closed runs of one name with only one usage.json mix. Match commits (stageDoneTimes) if that bites.
      const start = runStart.get(String(e["workspace"]));
      return !start || ms(at) >= ms(start);
    })
    .sort((a, b) => ms(String(a["at"])) - ms(String(b["at"])))
    .filter(firstPerPr());
  for (const e of events) {
    const at = String(e["at"]);
    const ws = String(e["workspace"]);
    let t = tl.get(ws);
    if (!t) {
      t = {};
      tl.set(ws, t);
    }
    if (typeof e["ticket"] === "string") t.ticket ??= e["ticket"];
    const pr = String(e["pr"] ?? "");
    switch (e["event"]) {
      case "answer":
        waitAt.push({ cause: "person", at, s: Number(e["waited_s"]) || 0 });
        break;
      case "queue.admit":
        waitAt.push({ cause: "capacity", at, s: Number(e["waited_s"]) || 0 });
        break;
      case "gate.start":
        t.firstGateStart ??= at;
        gateStart.set(String(e["run"]), at);
        break;
      case "gate.end": {
        const exit = Number(e["exit"]);
        const start = gateStart.get(String(e["run"]));
        if (exit === 75 && start)
          waitAt.push({ cause: "gateRetry", at, s: (ms(at) - ms(start)) / 1000 });
        if (exit !== 75) t.firstFinished ??= { at, exit };
        break;
      }
      case "pr.open":
        t.firstOpen = min(t.firstOpen, at);
        opened.set(pr, min(opened.get(pr), at));
        break;
      case "pr.merged": {
        t.lastMerged = max(t.lastMerged, at);
        merged.set(pr, at);
        const open = opened.get(pr);
        if (open) waitAt.push({ cause: "pr", at, s: (ms(at) - ms(open)) / 1000 });
        break;
      }
      case "release": {
        t.lastRelease = max(t.lastRelease, at);
        released.set(pr, at);
        const m = merged.get(pr);
        if (m) waitAt.push({ cause: "release", at, s: (ms(at) - ms(m)) / 1000 });
        break;
      }
    }
  }

  // Each workspace's earliest issue.start, where cycle starts (SW-1034). It can precede the first
  // turn, which the filter above drops for a closed run, so its floor is an earlier run's close-out.
  const inProgress = new Map<string, string>();
  for (const e of input.events) {
    const at = String(e["at"]);
    if (e["event"] !== "issue.start" || Number.isNaN(ms(at))) continue;
    const ws = String(e["workspace"]);
    const turn = firstTurn.get(ws);
    const floor = input.open.some((o) => o.workspace === ws)
      ? runStart.get(ws)
      : input.usages.reduce<string | undefined>(
          (a, u) =>
            u.workspace === ws && u.closedAt && turn && ms(u.closedAt) < ms(turn)
              ? max(a, u.closedAt)
              : a,
          undefined,
        );
    if (!floor || ms(at) >= ms(floor)) inProgress.set(ws, min(inProgress.get(ws), at));
  }

  // Waits by cause, bucketed by the ISO week of the event that ends them.
  const waits = zeroWaits();
  const byWeek = new Map<string, WaitSeconds>();
  const counted = waitAt.filter((w) => inRange(w.at));
  const firstWeek =
    from !== null ? from : counted.length ? Math.min(...counted.map((w) => ms(w.at))) : null;
  if (firstWeek !== null)
    for (let d = ms(weekOf(firstWeek)); d <= to; d += 7 * DAY_MS)
      byWeek.set(weekOf(d), zeroWaits());
  for (const w of counted) {
    const s = Math.round(w.s);
    waits[w.cause] += s;
    const week = byWeek.get(weekOf(ms(w.at)));
    if (week) week[w.cause] += s;
  }

  // Completed column visits, for each column's p50/p90.
  const onBoard = new Map(
    input.open.map((o) => [o.workspace, COLUMNS.indexOf(COLUMN_OF[o.lifecycle])]),
  );
  const visits: Record<FlowColumn, number[]> = {
    working: [],
    ready: [],
    "pr-open": [],
    "awaiting-release": [],
  };
  for (const ws of new Set([...tl.keys(), ...firstTurn.keys()])) {
    const t = tl.get(ws) ?? {};
    const spans: [FlowColumn, string | undefined, string | undefined][] = [
      ["working", firstTurn.get(ws), t.firstGateStart],
      ["ready", t.firstGateStart, t.firstOpen],
      ["pr-open", t.firstOpen, t.lastMerged],
      ["awaiting-release", t.lastMerged, t.lastRelease],
    ];
    // A card still on the board has completed only the columns before its current one.
    const current = onBoard.get(ws) ?? COLUMNS.length;
    for (const [col, start, end] of spans)
      if (start && inRange(end) && COLUMNS.indexOf(col) < current)
        visits[col].push(minutes(start, end));
  }

  const nowIso = now.toISOString();
  const board: FlowColumnReport[] = COLUMNS.map((column) => {
    const { p50Minutes, p90Minutes } = percentiles(visits[column]);
    const cards = input.open
      .filter((o) => COLUMN_OF[o.lifecycle] === column)
      .map((o): FlowCard => {
        const t = tl.get(o.workspace) ?? {};
        const enteredAt =
          {
            working: o.firstTurn,
            ready: t.firstGateStart ?? o.prFileAt,
            "pr-open": t.firstOpen,
            "awaiting-release": t.lastMerged,
          }[column] ?? null;
        const ageMinutes = enteredAt ? minutes(enteredAt, nowIso) : null;
        const since: [WaitCause, string | null | undefined][] = [
          ["person", o.askAt],
          ["capacity", o.waitingSince],
          ["pr", column === "pr-open" ? t.firstOpen : null],
          ["release", column === "awaiting-release" ? t.lastMerged : null],
        ];
        const open = since.find(([, s]) => s);
        return {
          workspace: o.workspace,
          ticket: o.ticket ?? t.ticket ?? null,
          stage: column === "working" ? o.stage : null,
          enteredAt,
          ageMinutes,
          overP90: ageMinutes !== null && p90Minutes !== null && ageMinutes > p90Minutes,
          wait: open?.[1]
            ? { cause: open[0], since: open[1], minutes: minutes(open[1], nowIso) }
            : null,
        };
      })
      .sort((a, b) => (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1));
    return { column, wip: cards.length, p50Minutes, p90Minutes, cards };
  });

  const ticketOf = new Map<string, string>();
  for (const u of input.usages) if (u.ticket) ticketOf.set(u.workspace, u.ticket);
  for (const o of input.open) if (o.ticket) ticketOf.set(o.workspace, o.ticket);
  const tickets: TicketTimes[] = [];
  for (const [ws, t] of tl) {
    const start = firstTurn.get(ws);
    if (!start || !inRange(t.lastMerged)) continue;
    const releasedAt = t.lastRelease ?? null;
    const inProgressAt = inProgress.get(ws) ?? null;
    tickets.push({
      ticket: t.ticket ?? ticketOf.get(ws) ?? ws,
      workspace: ws,
      firstTurn: start,
      inProgressAt,
      mergedAt: t.lastMerged,
      releasedAt,
      cycleMinutes: minutes(inProgressAt ?? start, t.lastMerged),
      leadMinutes: minutes(start, releasedAt ?? t.lastMerged),
    });
  }
  tickets.sort((a, b) => ms(a.mergedAt) - ms(b.mergedAt));

  const closed = input.usages.filter((u) => inRange(u.closedAt));
  const tokens: UsageTotals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const u of closed)
    for (const k of Object.keys(tokens) as (keyof UsageTotals)[]) tokens[k] += u.totals?.[k] ?? 0;
  const priced = closed.filter((u) => u.estUsd != null);
  const inputSide = tokens.input + tokens.cacheCreation + tokens.cacheRead;
  const sum = (f: (u: UsageRow) => number | null | undefined) =>
    closed.reduce((a, u) => a + (f(u) ?? 0), 0);

  const finished = [...tl.values()].flatMap((t) =>
    t.firstFinished && inRange(t.firstFinished.at) ? [t.firstFinished] : [],
  );
  const passed = finished.filter((f) => f.exit === 0).length;

  return {
    range,
    from: from === null ? null : new Date(from).toISOString(),
    to: nowIso,
    board,
    waitsByWeek: [...byWeek].map(([week, seconds]) => ({ week, seconds })),
    waits,
    tickets,
    cycle: percentiles(tickets.map((t) => t.cycleMinutes)),
    lead: percentiles(tickets.map((t) => t.leadMinutes)),
    usage: {
      workspaces: closed.length,
      estUsd: priced.length ? priced.reduce((a, u) => a + (u.estUsd ?? 0), 0) : null,
      costUnknown: closed.length - priced.length,
      tokens,
      cacheReadShare: inputSide ? tokens.cacheRead / inputSide : null,
      activeMinutes: sum((u) => u.activeMinutes),
      wallClockMinutes: sum((u) => u.wallClockMinutes),
      turns: sum((u) => u.turns),
    },
    gate: {
      firstPassRate: finished.length ? passed / finished.length : null,
      passed,
      workspaces: finished.length,
    },
    ...(workspace === undefined
      ? {}
      : { timeline: timelineOf(events, workspace, firstTurn.get(workspace)) }),
  };
}

/**
 * *workspace*'s events among *events* (already filtered to each run and sorted), as timeline rows,
 * after a `start` row at the run's first turn when that is known and comes first.
 */
function timelineOf(
  events: Record<string, unknown>[],
  workspace: string,
  firstTurn: string | undefined,
): TimelineEvent[] {
  const rows = events
    .filter((e) => e["workspace"] === workspace && TIMELINE_EVENTS.includes(String(e["event"])))
    .map((e) => ({
      at: String(e["at"]),
      event: String(e["event"]),
      ...(typeof e["stage"] === "string" ? { stage: e["stage"] } : {}),
      ...(typeof e["waited_s"] === "number" ? { waitedS: e["waited_s"] } : {}),
      ...(typeof e["exit"] === "number" ? { exit: e["exit"] } : {}),
      ...(typeof e["pr"] === "string" ? { pr: e["pr"] } : {}),
    }));
  return firstTurn && (!rows.length || ms(firstTurn) <= ms(rows[0].at))
    ? [{ at: firstTurn, event: "start" }, ...rows]
    : rows;
}

/** Every line of `<sandboxHome()>/metrics/events-*.jsonl` that parses and names its time, event and workspace. */
export function readMetricsEvents(): Record<string, unknown>[] {
  const dir = path.join(sandboxHome(), "metrics");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^events-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const f of files)
    for (const text of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      try {
        const e = JSON.parse(text);
        if (["at", "event", "workspace"].every((k) => typeof e?.[k] === "string")) out.push(e);
      } catch {}
    }
  return out;
}

/** `usage.json` from every record branch of the local workspace repo; never fetches. */
function recordBranchUsages(): UsageRow[] {
  const repo = path.join(getReposRoot(), WORKSPACE_ROOT_REPO);
  if (!fs.existsSync(repo)) return [];
  const refs = spawnSync(
    "git",
    ["-C", repo, "for-each-ref", "refs/heads", "--format=%(refname:short)"],
    { encoding: "utf8" },
  );
  if (refs.status !== 0) {
    warn(`metrics: could not list record branches in ${repo}: ${refs.stderr.trim()}`);
    return [];
  }
  const branches = refs.stdout.split("\n").filter(Boolean);
  if (!branches.length) return [];
  // Raw bytes: each reply's size is in bytes. A reply is "<sha> blob <size>\n<body>\n", or "<rev> missing\n".
  const batch = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: branches.map((b) => `${b}:usage.json\n`).join(""),
    maxBuffer: 1 << 28,
  });
  if (batch.status !== 0) {
    warn(`metrics: could not read usage.json from record branches: ${batch.stderr}`);
    return [];
  }
  const out: UsageRow[] = [];
  const buf = batch.stdout;
  let i = 0;
  while (i < buf.length) {
    const eol = buf.indexOf(10, i);
    if (eol < 0) break;
    const header = buf.toString("utf8", i, eol).split(" ");
    i = eol + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    const row = usageRow(buf.toString("utf8", i, i + size));
    if (row) out.push(row);
    i += size + 1;
  }
  return out;
}

/** The oldest open ask of *root*'s live sessions. Reads the files itself: readSessions deletes stale ones, and this tool is read-only. */
function oldestAsk(root: string, now: number): string | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDir(root)).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  const asks: string[] = [];
  for (const n of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(root), n), "utf8"));
      if (typeof s?.ask?.at === "string" && !sessionGone(s, now)) asks.push(s.ask.at);
    } catch {}
  }
  return asks.sort((a, b) => ms(a) - ms(b))[0] ?? null;
}

function usageRow(text: string): UsageRow | null {
  try {
    const u = JSON.parse(text);
    return typeof u?.workspace === "string" && typeof u?.closedAt === "string" ? u : null;
  } catch {
    return null;
  }
}

/**
 * The flow metrics over *range* (default `7d`): the board of open work (working with its ICM
 * stage, ready, pr-open, awaiting release) with each card's age and current wait, each column's
 * age p50/p90, waits by cause per week (person, capacity, PR open → merge, gate retries,
 * release), cycle and lead time per ticket, and cost, tokens, active and wall time, turns and
 * gate first-pass rate. Reads the metrics event log, `usage.json` from workspace folders and from
 * the record branches already on this machine (it never fetches), and each workspace's state.
 *
 * @param opts - `range`: `"7d"`, `"30d"`, `"90d"` or `"all"`; `workspace`: a workspace name, to add its run's `timeline`.
 * @returns The {@link MetricsReport}.
 *
 * @example
 * ```ts
 * import { metricsReport } from "werkmeister-core/sdk";
 *
 * const report = await metricsReport({ range: "30d" });
 * for (const col of report.board) console.log(col.column, col.wip, col.p90Minutes);
 * console.log(`${report.waits.person / 3600} h waiting on a person`);
 * ```
 */
export async function metricsReport(
  opts: { range?: MetricsRange; workspace?: string } = {},
  now = new Date(),
): Promise<MetricsReport> {
  const rows = await Promise.all(
    (await listWorkspaces()).workspaces.map(
      async (w): Promise<{ open?: OpenWorkspace; usage?: UsageRow }> => {
        const { state, prs } = lifecycleOf(w.path);
        if (state !== "working" && state !== "ready" && state !== "pr-open" && state !== "merged") {
          const file = path.join(w.path, "usage.json");
          const usage = fs.existsSync(file) ? usageRow(fs.readFileSync(file, "utf8")) : null;
          return usage ? { usage } : {};
        }
        const prTimes =
          state === "ready"
            ? prs.flatMap((p) => fs.statSync(p.path, { throwIfNoEntry: false })?.mtimeMs ?? [])
            : [];
        const sessions = await getWorkspaceUsage(w.name)
          .then((u) => u.sessions)
          .catch(() => []);
        const turns = sessions.flatMap((s) => s.firstTurn ?? []).sort((a, b) => ms(a) - ms(b));
        return {
          open: {
            workspace: w.name,
            ticket: w.issueId ?? null,
            lifecycle: state,
            stage: state === "working" ? await icmStage(w.path) : null,
            firstTurn: turns[0] ?? null,
            prFileAt: prTimes.length ? new Date(Math.max(...prTimes)).toISOString() : null,
            askAt: oldestAsk(w.path, now.getTime()),
            waitingSince: liveWaiting(w.path)?.since ?? null,
          },
        };
      },
    ),
  );
  const open = rows.flatMap((r) => r.open ?? []);
  const usages = rows.flatMap((r) => r.usage ?? []);
  const seen = new Set(usages.map((u) => `${u.workspace}|${u.closedAt}`));
  for (const u of recordBranchUsages())
    if (!seen.has(`${u.workspace}|${u.closedAt}`)) {
      seen.add(`${u.workspace}|${u.closedAt}`);
      usages.push(u);
    }
  return flowMetrics(
    { events: readMetricsEvents(), open, usages },
    opts.range ?? "7d",
    now,
    opts.workspace,
  );
}
