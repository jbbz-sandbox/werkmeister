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
import {
  branchFiles,
  type GateRowKind,
  gateRowKind,
  usageCachePath,
  WORK_TYPE_UNKNOWN,
} from "./metrics.js";
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
  /** Older than its work type's column p90 (the pooled one when `p90Pooled`): the red card. */
  overP90: boolean;
  /** The run's work type, `unknown` when nothing recorded it (SW-1212). */
  workType: string;
  /** `overP90` read the pooled column p90: its type has fewer than {@link WORK_TYPE_MIN_RUNS} completed visits of the column in range. */
  p90Pooled: boolean;
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
  /** How many completed visits p50/p90 come from. */
  count: number;
  /** Its open cards, oldest first. */
  cards: FlowCard[];
}
/** Summed usage of some `usage.json` snapshots. */
export interface UsageRollup {
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
}

/** Tokens and estimated cost per model. */
export type ModelRollup = Record<string, { tokens: UsageTotals; estUsd: number | null }>;

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
  /** The run's work type, `unknown` when nothing recorded it (SW-1212). */
  workType: string;
}
/** Nearest-rank percentiles, null with no values. */
export interface Percentiles {
  /** The median, in minutes. */
  p50Minutes: number | null;
  /** The 90th percentile, in minutes. */
  p90Minutes: number | null;
}
/** Below this many values a work type's column p90 falls back to the pooled one, and its bar is drawn faded (SW-1212). */
export const WORK_TYPE_MIN_RUNS = 5;
/** One column's segment of a work type's "where the time goes" bar. */
export interface WorkTypeColumn extends Percentiles {
  /** Which column. */
  column: FlowColumn;
  /** Completed visits of the column in range. */
  count: number;
}
/** Every flow metric over one work type's runs alone (SW-1212). */
export interface WorkTypeSlice {
  /** Runs of this type whose last PR merged in range: the bar's `n`. */
  runs: number;
  /** `runs` below {@link WORK_TYPE_MIN_RUNS}: drawn faded with a "few runs" note. */
  fewRuns: boolean;
  /** Percentiles of its tickets' cycle minutes. */
  cycle: Percentiles;
  /** Percentiles of its tickets' lead minutes. */
  lead: Percentiles;
  /** The four columns in flow order. */
  columns: WorkTypeColumn[];
  /** The columns' p50s summed: the bar's end, not the median cycle time. */
  sumOfMediansMinutes: number;
  /** Seconds waited, by cause. */
  waits: WaitSeconds;
  /** Its runs closed in range. */
  usage: UsageRollup;
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
  /** The work type asked for: the report covers only its runs. Null for all. */
  workType: string | null;
  /** Each work type with a run in the input, sliced alone; from every run whatever `workType` is. */
  byWorkType: Record<string, WorkTypeSlice>;
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
  /**
   * Active agent minutes per UTC day from the range's start (snapped to midnight; for `all`, the
   * first counted day) to today, oldest first, no gaps. A session counts wholly on its first
   * turn's day; a closed run whose `usage.json` has no session list counts wholly on its close day.
   */
  agentByDay: {
    /** The day, `YYYY-MM-DD`. */
    day: string;
    /** Active minutes of the sessions whose first turn fell on it. */
    activeMinutes: number;
  }[];
  /** Seconds waited over the whole range. */
  waits: WaitSeconds;
  /** Tickets whose last PR merged in the range, oldest merge first. */
  tickets: TicketTimes[];
  /** Percentiles of `tickets` cycle minutes. */
  cycle: Percentiles;
  /** Percentiles of `tickets` lead minutes. */
  lead: Percentiles;
  /** Deployment frequency: distinct (repo, tag) `release`s in the range, and per ISO week. */
  releases: {
    /** Releases in the range. */
    total: number;
    /** ISO weeks (Monday, UTC), oldest first. */
    byWeek: {
      /** The week's Monday, `YYYY-MM-DD`. */
      week: string;
      /** Releases first shipped that week. */
      count: number;
    }[];
  };
  /** Workspaces whose `usage.json` closedAt is in the range. */
  usage: UsageRollup & {
    /** Per person: the git author of the record branch, cached by `metrics rebuild`; `"unknown"` before one. `lead` covers their `tickets`. */
    byPerson: Record<
      string,
      UsageRollup & {
        /** Percentiles of that person's `tickets` lead minutes. */
        lead: Percentiles;
      }
    >;
    /** Per tracker project: the ticket key's prefix, `"none"` without a ticket. */
    byProject: Record<string, UsageRollup>;
    /** Per model, from each snapshot's `byModel`. */
    byModel: ModelRollup;
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
  /** Its `workspace.yml` work_type, or null. */
  workType?: string | null;
  /** Its sessions' first turns and active minutes, for `agentByDay`. */
  sessions?: { firstTurn: string | null; activeMinutes: number | null }[];
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
> &
  Partial<
    Pick<
      UsageSnapshot,
      "outcome" | "stages" | "byModel" | "werkmeister" | "sessions" | "unstagedTokens"
    >
  > & {
    /** The record branch's git author email, from the `metrics rebuild` cache (SW-1104). */
    by?: string;
    /** The record branch's `workspace.yml` work_type, from the `metrics rebuild` cache (SW-1212). */
    work_type?: string;
  };
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

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const group = out.get(k);
    if (group) group.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Summed cost, tokens, minutes and turns of *rows*. */
function usageRollup(rows: UsageRow[]): UsageRollup {
  const tokens = zeroTokens();
  for (const u of rows) addTokens(tokens, u.totals);
  const priced = rows.filter((u) => u.estUsd != null);
  const inputSide = tokens.input + tokens.cacheCreation + tokens.cacheRead;
  const sum = (f: (u: UsageRow) => number | null | undefined) =>
    rows.reduce((a, u) => a + (f(u) ?? 0), 0);
  return {
    workspaces: rows.length,
    estUsd: priced.length ? priced.reduce((a, u) => a + (u.estUsd ?? 0), 0) : null,
    costUnknown: rows.length - priced.length,
    tokens,
    cacheReadShare: inputSide ? tokens.cacheRead / inputSide : null,
    activeMinutes: sum((u) => u.activeMinutes),
    wallClockMinutes: sum((u) => u.wallClockMinutes),
    turns: sum((u) => u.turns),
  };
}

/** Tokens and cost per model over *rows*' `byModel`. */
function modelRollup(rows: UsageRow[]): ModelRollup {
  const byModel: ModelRollup = {};
  for (const u of rows)
    for (const m of u.byModel ?? []) {
      const row = (byModel[m.model] ??= { tokens: zeroTokens(), estUsd: null });
      addTokens(row.tokens, m.totals);
      if (m.estUsd != null) row.estUsd = (row.estUsd ?? 0) + m.estUsd;
    }
  return byModel;
}

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

/**
 * Each workspace's first turn (an open workspace's own run wins over a closed run of its name),
 * where each run's events start, and *input*'s events of those runs, oldest first, with doubled
 * `pr.*` / `release` lines dropped.
 */
function runEvents(input: FlowInput): {
  firstTurn: Map<string, string>;
  runStart: Map<string, string>;
  events: Record<string, unknown>[];
} {
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
  return { firstTurn, runStart, events };
}

type FlowCore = Omit<MetricsReport, "workType" | "byWorkType">;

/**
 * Each workspace's work type, last wins: the rebuild cache, then create/init lines, then an open
 * workspace's own workspace.yml (SW-1212). Keyed by name, as {@link runEvents} is.
 */
function workTypes(input: FlowInput): Map<string, string> {
  const out = new Map<string, string>();
  for (const u of [...input.usages].sort((a, b) => ms(a.closedAt) - ms(b.closedAt)))
    if (u.work_type) out.set(u.workspace, u.work_type);
  for (const e of [...input.events].sort((a, b) => ms(String(a["at"])) - ms(String(b["at"]))))
    if (
      (e["event"] === "workspace.create" || e["event"] === "workspace.init") &&
      typeof e["work_type"] === "string"
    )
      out.set(String(e["workspace"]), e["work_type"]);
  for (const o of input.open) if (o.workType) out.set(o.workspace, o.workType);
  return out;
}

/** *input* cut to the runs of *type*. */
function sliceInput(input: FlowInput, types: Map<string, string>, type: string): FlowInput {
  const of = (ws: unknown) => (types.get(String(ws)) ?? WORK_TYPE_UNKNOWN) === type;
  return {
    events: input.events.filter((e) => of(e["workspace"])),
    open: input.open.filter((o) => of(o.workspace)),
    usages: input.usages.filter((u) => of(u.workspace)),
  };
}

/**
 * The report for *input* over *range*, as of *now*, over *workType*'s runs only when given. Pure: the
 * formulas of § Definitions. `byWorkType` runs the same formulas over each type's runs alone, and a
 * card is red against its own type's column p90, or the pooled one below {@link WORK_TYPE_MIN_RUNS}.
 */
export function flowMetrics(
  input: FlowInput,
  range: MetricsRange,
  now: Date,
  workspace?: string,
  workType?: string,
): MetricsReport {
  const types = workTypes(input);
  const typeOf = (ws: string) => types.get(ws) ?? WORK_TYPE_UNKNOWN;
  const core = (i: FlowInput) => flowCore(i, range, now, typeOf, workspace);
  const pooled = core(input);
  const names = [
    ...input.events.flatMap((e) => (typeof e["workspace"] === "string" ? [e["workspace"]] : [])),
    ...[...input.open, ...input.usages].map((r) => r.workspace),
  ];
  const own = new Map<string, FlowCore>();
  for (const t of new Set(names.map(typeOf))) own.set(t, core(sliceInput(input, types, t)));
  const base = workType ? (own.get(workType) ?? core(sliceInput(input, types, workType))) : pooled;
  for (const col of base.board)
    for (const c of col.cards) {
      const mine = own.get(c.workType)?.board.find((b) => b.column === col.column);
      c.p90Pooled = !mine || mine.count < WORK_TYPE_MIN_RUNS;
      const p90 = c.p90Pooled
        ? pooled.board.find((b) => b.column === col.column)?.p90Minutes
        : mine?.p90Minutes;
      c.overP90 = c.ageMinutes !== null && p90 != null && c.ageMinutes > p90;
    }
  const byWorkType: Record<string, WorkTypeSlice> = {};
  for (const [t, r] of [...own].sort(([a], [b]) => a.localeCompare(b))) {
    const { byPerson: _p, byProject: _j, byModel: _m, ...usage } = r.usage;
    const columns = r.board.map(({ column, count, p50Minutes, p90Minutes }) => ({
      column,
      count,
      p50Minutes,
      p90Minutes,
    }));
    byWorkType[t] = {
      runs: r.tickets.length,
      fewRuns: r.tickets.length < WORK_TYPE_MIN_RUNS,
      cycle: r.cycle,
      lead: r.lead,
      columns,
      sumOfMediansMinutes: columns.reduce((a, c) => a + (c.p50Minutes ?? 0), 0),
      waits: r.waits,
      usage,
    };
  }
  return { ...base, workType: workType ?? null, byWorkType };
}

function flowCore(
  input: FlowInput,
  range: MetricsRange,
  now: Date,
  typeOf: (ws: string) => string,
  workspace?: string,
): FlowCore {
  const to = now.getTime();
  const from = range === "all" ? null : to - Number.parseInt(range, 10) * DAY_MS;
  const inRange = (t: string | undefined | null): t is string =>
    !!t && ms(t) <= to && (from === null || ms(t) >= from);
  const { firstTurn, runStart, events } = runEvents(input);

  const tl = new Map<string, Timeline>();
  const waitAt: { cause: WaitCause; at: string; s: number }[] = [];
  const opened = new Map<string, string>();
  const merged = new Map<string, string>();
  const released = new Map<string, string>();
  const gateStart = new Map<string, string>();
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
          // Set per work type by flowMetrics.
          overP90: false,
          workType: typeOf(o.workspace),
          p90Pooled: false,
          wait: open?.[1]
            ? { cause: open[0], since: open[1], minutes: minutes(open[1], nowIso) }
            : null,
        };
      })
      .sort((a, b) => (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1));
    return {
      column,
      wip: cards.length,
      p50Minutes,
      p90Minutes,
      count: visits[column].length,
      cards,
    };
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
      workType: typeOf(ws),
    });
  }
  tickets.sort((a, b) => ms(a.mergedAt) - ms(b.mergedAt));

  const closed = input.usages.filter((u) => inRange(u.closedAt));
  const personOf = new Map(input.usages.map((u) => [u.workspace, u.by ?? "unknown"]));
  const byPerson: MetricsReport["usage"]["byPerson"] = {};
  for (const [person, rows] of groupBy(closed, (u) => u.by ?? "unknown"))
    byPerson[person] = {
      ...usageRollup(rows),
      lead: percentiles(
        tickets.filter((t) => personOf.get(t.workspace) === person).map((t) => t.leadMinutes),
      ),
    };
  const byProject: MetricsReport["usage"]["byProject"] = {};
  for (const [project, rows] of groupBy(
    closed,
    (u) => /^([A-Z][A-Z0-9]*)-\d+$/.exec(u.ticket ?? "")?.[1] ?? "none",
  ))
    byProject[project] = usageRollup(rows);

  // Deployment frequency (SW-1104): distinct (repo, tag) releases, by the week each first shipped.
  const releaseAt = new Map<string, string>();
  for (const e of events)
    if (e["event"] === "release" && inRange(String(e["at"]))) {
      const key = `${String(e["pr"]).replace(/\/pull\/\d+$/, "")}|${e["tag"]}`;
      releaseAt.set(key, min(releaseAt.get(key), String(e["at"])));
    }
  const releaseWeeks = new Map([...byWeek.keys()].map((w): [string, number] => [w, 0]));
  for (const at of releaseAt.values()) {
    const w = weekOf(ms(at));
    releaseWeeks.set(w, (releaseWeeks.get(w) ?? 0) + 1);
  }

  const finished = [...tl.values()].flatMap((t) =>
    t.firstFinished && inRange(t.firstFinished.at) ? [t.firstFinished] : [],
  );
  const passed = finished.filter((f) => f.exit === 0).length;

  // shortcut: a session crossing midnight counts on its start day; split activeSpans per day
  // if a day's bar needs to be exact.
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  type Worked = { firstTurn: string | null; activeMinutes: number | null };
  const sessions = [
    // A reused name's folder still holds the earlier run's transcripts, already in its usage.json.
    ...input.open.flatMap((o) => {
      const start = runStart.get(o.workspace);
      return (o.sessions ?? []).filter(
        (s) => !start || (s.firstTurn !== null && ms(s.firstTurn) >= ms(start)),
      );
    }),
    // shortcut: a snapshot with no session list counts wholly on its close day; fine once
    // pre-sessions snapshots age out of the ranges people look at.
    ...input.usages.flatMap<Worked>(
      (u) => u.sessions ?? [{ firstTurn: u.closedAt, activeMinutes: u.activeMinutes }],
    ),
  ];
  const worked = sessions.flatMap((s) =>
    s.firstTurn && s.activeMinutes && ms(s.firstTurn) <= to
      ? [{ t: ms(s.firstTurn), m: s.activeMinutes }]
      : [],
  );
  const firstDay =
    from !== null
      ? ms(dayOf(from))
      : worked.length
        ? ms(dayOf(Math.min(...worked.map((w) => w.t))))
        : null;
  const agentDays = new Map<string, number>();
  if (firstDay !== null) for (let d = firstDay; d <= to; d += DAY_MS) agentDays.set(dayOf(d), 0);
  for (const w of worked) {
    const day = dayOf(w.t);
    if (agentDays.has(day)) agentDays.set(day, (agentDays.get(day) ?? 0) + w.m);
  }

  return {
    range,
    from: from === null ? null : new Date(from).toISOString(),
    to: nowIso,
    board,
    waitsByWeek: [...byWeek].map(([week, seconds]) => ({ week, seconds })),
    agentByDay: [...agentDays].map(([day, activeMinutes]) => ({ day, activeMinutes })),
    waits,
    tickets,
    cycle: percentiles(tickets.map((t) => t.cycleMinutes)),
    lead: percentiles(tickets.map((t) => t.leadMinutes)),
    releases: {
      total: releaseAt.size,
      byWeek: [...releaseWeeks]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, count]) => ({ week, count })),
    },
    usage: { ...usageRollup(closed), byPerson, byProject, byModel: modelRollup(closed) },
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
  return [...(branchFiles(repo, branches, "usage.json")?.values() ?? [])].flatMap(
    (t) => usageRow(t) ?? [],
  );
}

/** Every branch's `usage.json` with its author, as `metrics rebuild` last cached it (SW-1104). */
function cachedUsages(): UsageRow[] {
  let text = "";
  try {
    text = fs.readFileSync(usageCachePath(), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((t) => usageRow(t) ?? []);
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
 * @param opts - `range`: `"7d"`, `"30d"`, `"90d"` or `"all"`; `workspace`: a workspace name, to add its run's `timeline`; `workType`: only that work type's runs (`unknown` for untyped ones).
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
  opts: { range?: MetricsRange; workspace?: string; workType?: string } = {},
  now = new Date(),
): Promise<MetricsReport> {
  return flowMetrics(await flowInput(now), opts.range ?? "7d", now, opts.workspace, opts.workType);
}

/** The event log, open workspaces' state, and `usage.json` from workspace folders and local record branches. */
async function flowInput(now: Date): Promise<FlowInput> {
  const rows = await Promise.all(
    (await listWorkspaces()).workspaces.map(
      async (w): Promise<{ open?: OpenWorkspace; usage?: UsageRow }> => {
        const { state, prs } = lifecycleOf(w.path);
        if (state !== "working" && state !== "ready" && state !== "pr-open" && state !== "merged") {
          const file = path.join(w.path, "usage.json");
          const usage = fs.existsSync(file) ? usageRow(fs.readFileSync(file, "utf8")) : null;
          // A closed folder still on disk types its run without a rebuild (SW-1212).
          const work_type = usage?.work_type ?? w.workType?.toLowerCase();
          return usage ? { usage: { ...usage, ...(work_type && { work_type }) } } : {};
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
            // Lowercased as workTypeOf does for event lines: `Bugfix` is bugfix.
            workType: w.workType?.toLowerCase() ?? null,
            sessions,
          },
        };
      },
    ),
  );
  const open = rows.flatMap((r) => r.open ?? []);
  const usages: UsageRow[] = [];
  const seen = new Set<string>();
  // The rebuild cache first: of one snapshot's copies, only it carries `by`.
  for (const u of [
    ...cachedUsages(),
    ...rows.flatMap((r) => r.usage ?? []),
    ...recordBranchUsages(),
  ])
    if (!seen.has(`${u.workspace}|${u.closedAt}`)) {
      seen.add(`${u.workspace}|${u.closedAt}`);
      usages.push(u);
    }
  return { events: readMetricsEvents(), open, usages };
}

/** A `metrics-trends` bucket size. */
export type TrendBucket = "day" | "week";
/** Every `TrendBucket`. */
export const TREND_BUCKETS: readonly TrendBucket[] = ["day", "week"];
/** Nearest-rank percentiles and how many values they came from. */
export interface CountedPercentiles extends Percentiles {
  /** How many values. */
  count: number;
}
/** One package's test minutes in a bucket. */
export interface SuiteTrend extends CountedPercentiles {
  /** Runs turbo replayed from its cache, left out of the percentiles. */
  cached: number;
  /** Runs whose tests failed. */
  failed: number;
}
/** One ICM stage's minutes in a bucket: percentiles over runs, and sums split by what it waited on. */
export interface StageTrend extends CountedPercentiles {
  /** Summed wall minutes, the previous stage's end → this stage's end. */
  totalMinutes: number;
  /** Summed minutes of `answer` waits (`waited_s` before it) inside the stage. */
  personMinutes: number;
  /** Summed minutes of `queue.admit` waits inside the stage. */
  capacityMinutes: number;
  /** Summed minutes of each run's stage with no wait of any cause (a person and a capacity wait at once count once). */
  workingMinutes: number;
  /** Summed tokens of the turns in the stage's window, over the runs whose `usage.json` has them. */
  tokens: UsageTotals;
  /** How many runs had stage tokens (snapshots closed before SW-1100 have none). */
  tokenRuns: number;
}
/** Tokens and cost of the shipped tickets closed in a bucket, each ticket's snapshots summed. */
export interface TicketCost {
  /** Shipped tickets. */
  tickets: number;
  /** Nearest-rank p50 of each ticket's tokens (all four kinds), or null with none. */
  p50Tokens: number | null;
  /** Nearest-rank p90 of each ticket's tokens. */
  p90Tokens: number | null;
  /** p50 of each priced ticket's estimated USD, or null with none priced. */
  p50Usd: number | null;
  /** p90 of each priced ticket's estimated USD. */
  p90Usd: number | null;
  /** Tickets with any workspace lacking a cost estimate, left out of the USD percentiles. */
  unpriced: number;
}
/** A shipped ticket's summed tokens and cost. */
export interface CostlyTicket {
  /** The tracker key, or the workspace name when there is none. */
  ticket: string;
  /** Its workspaces closed in the bucket. */
  workspaces: string[];
  /** Summed tokens, all four kinds. */
  tokens: number;
  /** Summed estimated USD, or null when none is priced. */
  estUsd: number | null;
}
/** Tokens and cost of the abandoned snapshots closed in a bucket. */
export interface AbandonedSpend {
  /** Abandoned workspaces. */
  workspaces: number;
  /** Their summed tokens. */
  tokens: UsageTotals;
  /** Their summed estimated USD, or null when none is priced. */
  estUsd: number | null;
  /** Abandoned workspaces with no cost estimate. */
  costUnknown: number;
}
/** A ticket whose lead time ends in a bucket. */
export interface SlowTicket {
  /** The tracker key, or the workspace name when there is none. */
  ticket: string;
  /** The workspace folder name. */
  workspace: string;
  /** First turn → last `pr.merged`, when that merge is in the bucket. */
  leadToMergeMinutes: number | null;
  /** First turn → last `release`, when that release is in the bucket. */
  leadToReleaseMinutes: number | null;
}
/** One bucket's numbers, for every version or for one. */
export interface TrendSlice {
  /** `usage.json` snapshots with outcome shipped, closed in the bucket. */
  shipped: number;
  /** Snapshots with outcome abandoned, closed in the bucket. */
  abandoned: number;
  /** Minutes per ICM stage (`02_spec`, …), by the bucket each stage finished in. */
  stages: Record<string, StageTrend>;
  /** Up to 5 tickets with the longest lead (to release, else to merge), longest first. */
  slowest: SlowTicket[];
  /** First turn → last `pr.merged`, by the merge's bucket. */
  leadToMerge: CountedPercentiles;
  /** First turn → last `release`, by the release's bucket. */
  leadToRelease: CountedPercentiles;
  /** Summed tokens of the snapshots closed in the bucket. */
  tokens: UsageTotals;
  /** Their summed estimated cost in USD, or null when none has one. */
  estUsd: number | null;
  /** Snapshots with no cost estimate. */
  costUnknown: number;
  /** Tokens and cost per model. */
  byModel: Record<
    string,
    {
      /** That model's summed tokens. */
      tokens: UsageTotals;
      /** Its summed estimated cost in USD, or null when no snapshot priced it. */
      estUsd: number | null;
    }
  >;
  /** Cache reads ÷ (input + cache creation + cache reads), or null with no input tokens. */
  cacheReadShare: number | null;
  /** Summed tokens of the turns after each snapshot's last finished stage. */
  unstagedTokens: UsageTotals;
  /** Per shipped ticket: tokens and cost percentiles. */
  perTicket: TicketCost;
  /** Up to 5 shipped tickets, highest cost (then tokens) first. */
  costliest: CostlyTicket[];
  /** Spend on abandoned workspaces. */
  abandonedSpend: AbandonedSpend;
  /** Summed active minutes. */
  activeMinutes: number;
  /** Summed wall-clock minutes. */
  wallClockMinutes: number;
  /** Gate runs that finished (exit ≠ 75; a 75 is a capacity retry, a `gateRetry` wait in `metrics`), by their end. */
  gate: {
    /** How many. */
    runs: number;
    /** Their summed `gate.start` → `gate.end` minutes. */
    wallMinutes: number;
    /** `passed ÷ workspaces`, or null with none. */
    firstPassRate: number | null;
    /** Workspaces whose first finished run, ending in the bucket, exited 0. */
    passed: number;
    /** Workspaces whose first finished run ended in the bucket. */
    workspaces: number;
    /** Summed `gate.row` minutes per row kind, to 0.1 min. */
    byKind: Record<GateRowKind, number>;
  };
  /** Test minutes per package: percentiles over uncached test-task runs, from `test.run` (else a `test <svc>` gate row). */
  tests: Record<string, SuiteTrend>;
}
/** One bucket of {@link MetricsTrends}. */
export interface TrendRow extends TrendSlice {
  /** `week`: its Monday (UTC); `day`: the UTC date; `YYYY-MM-DD`. */
  bucket: string;
  /** The same numbers per `usage.json` `werkmeister.version` of each item's workspace, `"unknown"` with none. */
  byVersion: Record<string, TrendSlice>;
}
/**
 * What {@link metricsTrends} returns.
 *
 * @example
 * ```ts
 * import { type MetricsTrends, metricsTrends } from "werkmeister-core/sdk";
 *
 * const trends: MetricsTrends = await metricsTrends({ bucket: "day" });
 * console.log(trends.rows.map((r) => [r.bucket, Object.keys(r.byVersion)]));
 * ```
 */
export interface MetricsTrends {
  /** The range asked for. */
  range: MetricsRange;
  /** The bucket size asked for. */
  bucket: TrendBucket;
  /** The range's start rounded down to its bucket's start (Monday or midnight, UTC), or null for `all`. */
  from: string | null;
  /** The range's end: now. */
  to: string;
  /** One row per bucket from the range's start (for `all`, the oldest item) to now, oldest first, no gaps. */
  rows: TrendRow[];
  /** Test minutes per package over the whole range, every version: ranks the slowest suites. */
  suites: Record<string, CountedPercentiles>;
  /** {@link MetricsTrends.suites} per werkmeister version. */
  suitesByVersion: Record<string, Record<string, CountedPercentiles>>;
}

type TrendItem = { at: string; version: string } & (
  | { kind: "closed"; usage: UsageRow }
  | {
      kind: "stage";
      stage: string;
      minutes: number;
      person: number;
      capacity: number;
      working: number;
      tokens: UsageTotals | null;
    }
  | {
      kind: "leadToMerge" | "leadToRelease";
      minutes: number;
      workspace: string;
      ticket: string;
    }
  | { kind: "gate"; minutes: number }
  | { kind: "gateRow"; rowKind: GateRowKind; minutes: number }
  | { kind: "testRun"; package: string; minutes: number; cached: boolean; failed: boolean }
  | { kind: "firstGate"; passed: boolean }
);

const zeroTokens = (): UsageTotals => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
const addTokens = (a: UsageTotals, b: UsageTotals | undefined) => {
  for (const k of Object.keys(a) as (keyof UsageTotals)[]) a[k] += b?.[k] ?? 0;
};
const counted = (values: number[]): CountedPercentiles => ({
  ...percentiles(values),
  count: values.length,
});

const slowLead = (t: SlowTicket) => t.leadToReleaseMinutes ?? t.leadToMergeMinutes ?? 0;
const sortSlowest = (ts: SlowTicket[]) => ts.sort((a, b) => slowLead(b) - slowLead(a)).slice(0, 5);
// Optional: a hand-written or older usage.json can lack totals, as addTokens allows.
const tokenSum = (t: UsageTotals | undefined) =>
  t ? t.input + t.output + t.cacheCreation + t.cacheRead : 0;

/** *rows*' shipped snapshots summed per ticket (workspace name when none). */
function shippedTickets(rows: UsageRow[]): { tickets: CostlyTicket[]; partial: Set<string> } {
  const byTicket = new Map<string, CostlyTicket>();
  // A ticket with any unpriced workspace counts as unpriced, so a partial cost never reads as the whole (SW-1100 Q3).
  const partial = new Set<string>();
  for (const u of rows) {
    if (u.outcome !== "shipped") continue;
    const key = u.ticket ?? u.workspace;
    const t = byTicket.get(key) ?? { ticket: key, workspaces: [], tokens: 0, estUsd: null };
    t.workspaces.push(u.workspace);
    t.tokens += tokenSum(u.totals);
    if (u.estUsd != null) t.estUsd = (t.estUsd ?? 0) + u.estUsd;
    else partial.add(key);
    byTicket.set(key, t);
  }
  return { tickets: [...byTicket.values()], partial };
}

function ticketCost({ tickets, partial }: ReturnType<typeof shippedTickets>): TicketCost {
  const tokens = tickets.map((t) => t.tokens);
  const usd = tickets.flatMap((t) => (t.estUsd == null || partial.has(t.ticket) ? [] : [t.estUsd]));
  return {
    tickets: tickets.length,
    p50Tokens: percentile(tokens, 0.5),
    p90Tokens: percentile(tokens, 0.9),
    p50Usd: percentile(usd, 0.5),
    p90Usd: percentile(usd, 0.9),
    unpriced: tickets.length - usd.length,
  };
}

const sortCostliest = (ts: CostlyTicket[]) =>
  [...ts].sort((a, b) => (b.estUsd ?? 0) - (a.estUsd ?? 0) || b.tokens - a.tokens).slice(0, 5);

function stageTokenSum(runs: Extract<TrendItem, { kind: "stage" }>[]) {
  const tokens = zeroTokens();
  let tokenRuns = 0;
  for (const r of runs)
    if (r.tokens) {
      addTokens(tokens, r.tokens);
      tokenRuns++;
    }
  return { tokens, tokenRuns };
}

function trendSlice(items: TrendItem[]): TrendSlice {
  const closed = items.flatMap((i) => (i.kind === "closed" ? [i.usage] : []));
  const minutesOf = (kind: TrendItem["kind"]) =>
    items.flatMap((i) => (i.kind === kind && "minutes" in i ? [i.minutes] : []));
  const stageRuns = new Map<string, Extract<TrendItem, { kind: "stage" }>[]>();
  for (const i of items)
    if (i.kind === "stage") stageRuns.set(i.stage, [...(stageRuns.get(i.stage) ?? []), i]);
  const sumOf = (ns: number[]) => Math.round(ns.reduce((a, n) => a + n, 0));
  const slow = new Map<string, SlowTicket>();
  for (const i of items) {
    if (i.kind !== "leadToMerge" && i.kind !== "leadToRelease") continue;
    const t = slow.get(i.workspace) ?? {
      ticket: i.ticket,
      workspace: i.workspace,
      leadToMergeMinutes: null,
      leadToReleaseMinutes: null,
    };
    t[i.kind === "leadToMerge" ? "leadToMergeMinutes" : "leadToReleaseMinutes"] = i.minutes;
    slow.set(i.workspace, t);
  }
  // The same cost math as the report's usage (SW-1128), so the two can't drift apart.
  const { tokens, estUsd, costUnknown, cacheReadShare, activeMinutes, wallClockMinutes } =
    usageRollup(closed);
  const firstGates = items.flatMap((i) => (i.kind === "firstGate" ? [i.passed] : []));
  const passed = firstGates.filter(Boolean).length;
  const gateMinutes = minutesOf("gate");
  const tickets = shippedTickets(closed);
  const abandoned = usageRollup(closed.filter((u) => u.outcome === "abandoned"));
  const unstagedTokens = zeroTokens();
  for (const u of closed) addTokens(unstagedTokens, u.unstagedTokens);
  return {
    shipped: closed.filter((u) => u.outcome === "shipped").length,
    abandoned: closed.filter((u) => u.outcome === "abandoned").length,
    stages: Object.fromEntries(
      [...stageRuns].map(([s, runs]) => [
        s,
        {
          ...counted(runs.map((r) => r.minutes)),
          totalMinutes: sumOf(runs.map((r) => r.minutes)),
          personMinutes: sumOf(runs.map((r) => r.person)),
          capacityMinutes: sumOf(runs.map((r) => r.capacity)),
          workingMinutes: sumOf(runs.map((r) => r.working)),
          ...stageTokenSum(runs),
        },
      ]),
    ),
    slowest: sortSlowest([...slow.values()]),
    leadToMerge: counted(minutesOf("leadToMerge")),
    leadToRelease: counted(minutesOf("leadToRelease")),
    tokens,
    estUsd,
    costUnknown,
    byModel: modelRollup(closed),
    cacheReadShare,
    unstagedTokens,
    perTicket: ticketCost(tickets),
    costliest: sortCostliest(tickets.tickets),
    abandonedSpend: {
      workspaces: abandoned.workspaces,
      tokens: abandoned.tokens,
      estUsd: abandoned.estUsd,
      costUnknown: abandoned.costUnknown,
    },
    activeMinutes,
    wallClockMinutes,
    gate: {
      runs: gateMinutes.length,
      wallMinutes: Math.round(gateMinutes.reduce((a, m) => a + m, 0)),
      firstPassRate: firstGates.length ? passed / firstGates.length : null,
      passed,
      workspaces: firstGates.length,
      byKind: Object.fromEntries(
        GATE_ROW_KINDS.map((k) => [
          k,
          Math.round(
            items.reduce(
              (a, i) => a + (i.kind === "gateRow" && i.rowKind === k ? i.minutes : 0),
              0,
            ) * 10,
          ) / 10,
        ]),
      ) as Record<GateRowKind, number>,
    },
    tests: Object.fromEntries(
      [...testRuns(items)].map(([pkg, runs]) => [
        pkg,
        {
          ...counted(runs.filter((r) => !r.cached).map((r) => r.minutes)),
          cached: runs.filter((r) => r.cached).length,
          failed: runs.filter((r) => r.failed).length,
        },
      ]),
    ),
  };
}

const GATE_ROW_KINDS: readonly GateRowKind[] = ["setup", "lint", "test", "release", "checks"];

function testRuns(items: TrendItem[]): Map<string, Extract<TrendItem, { kind: "testRun" }>[]> {
  const out = new Map<string, Extract<TrendItem, { kind: "testRun" }>[]>();
  for (const i of items)
    if (i.kind === "testRun") out.set(i.package, [...(out.get(i.package) ?? []), i]);
  return out;
}

/** Uncached test minutes per package. */
const suitePercentiles = (items: TrendItem[]) =>
  Object.fromEntries(
    [...testRuns(items)].map(([pkg, runs]) => [
      pkg,
      counted(runs.filter((r) => !r.cached).map((r) => r.minutes)),
    ]),
  );

/**
 * *input* as one row per *bucket* over *range*, as of *now*, each split by werkmeister version.
 * Pure. Every item lands in the bucket of the time it ended (SW-1097 Q3).
 */
export function trendSeries(
  all: FlowInput,
  range: MetricsRange,
  bucket: TrendBucket,
  now: Date,
  /** Only this work type's runs (SW-1212). */
  workType?: string,
): MetricsTrends {
  const input = workType ? sliceInput(all, workTypes(all), workType) : all;
  const to = now.getTime();
  const bucketOf = (t: number) =>
    bucket === "week" ? weekOf(t) : new Date(t).toISOString().slice(0, 10);
  // Snapped to its bucket's start, so the first row holds its whole week or day (SW-1112).
  const from = range === "all" ? null : ms(bucketOf(to - Number.parseInt(range, 10) * DAY_MS));
  const inRange = (t: string | undefined | null): t is string =>
    !!t && !Number.isNaN(ms(t)) && ms(t) <= to && (from === null || ms(t) >= from);

  // The newest snapshot of a workspace names its version (SW-1097 Q4).
  const version = new Map<string, { closedAt: string; v: string }>();
  for (const u of input.usages) {
    const seen = version.get(u.workspace);
    if (!seen || ms(u.closedAt) > ms(seen.closedAt))
      version.set(u.workspace, { closedAt: u.closedAt, v: u.werkmeister?.version ?? "unknown" });
  }
  const versionOf = (ws: string) => version.get(ws)?.v ?? "unknown";

  const { firstTurn, events } = runEvents(input);
  // `any` is every wait whatever its cause: a person and a capacity wait at once is one wait to working.
  type WaitCauseOrAny = "person" | "capacity" | "any";
  const waits = new Map<string, { cause: WaitCauseOrAny; from: number; to: number }[]>();
  for (const e of events) {
    const cause =
      e["event"] === "answer" ? "person" : e["event"] === "queue.admit" ? "capacity" : null;
    const s = Number(e["waited_s"]) || 0;
    if (!cause || s <= 0) continue;
    const ws = String(e["workspace"]);
    const at = ms(String(e["at"]));
    const list = waits.get(ws) ?? [];
    list.push(
      { cause, from: at - s * 1000, to: at },
      { cause: "any", from: at - s * 1000, to: at },
    );
    waits.set(ws, list);
  }
  // Parallel sessions can wait at once: merge each cause's overlapping windows so none counts twice.
  for (const [ws, list] of waits) {
    const merged: typeof list = [];
    for (const w of [...list].sort((a, b) => a.cause.localeCompare(b.cause) || a.from - b.from)) {
      const last = merged.at(-1);
      if (last?.cause === w.cause && w.from <= last.to) last.to = Math.max(last.to, w.to);
      else merged.push({ ...w });
    }
    waits.set(ws, merged);
  }

  const items: TrendItem[] = [];
  const ticketOf = new Map<string, string>();
  for (const o of input.open) if (o.ticket) ticketOf.set(o.workspace, o.ticket);
  for (const u of input.usages) {
    const v = versionOf(u.workspace);
    if (u.ticket) ticketOf.set(u.workspace, u.ticket);
    items.push({ at: u.closedAt, version: v, kind: "closed", usage: u });
    for (const s of u.stages ?? []) {
      if (!s.finishedAt || s.minutes == null) continue;
      // `minutes` is the previous stage's end → this one's (usage_snapshot), so this is its window.
      const end = ms(s.finishedAt);
      const start = end - s.minutes * 60_000;
      const waited: Record<WaitCauseOrAny, number> = { person: 0, capacity: 0, any: 0 };
      for (const w of waits.get(u.workspace) ?? [])
        waited[w.cause] += Math.max(0, Math.min(end, w.to) - Math.max(start, w.from)) / 60_000;
      items.push({
        at: s.finishedAt,
        version: v,
        kind: "stage",
        stage: s.stage,
        minutes: s.minutes,
        person: waited.person,
        capacity: waited.capacity,
        working: Math.max(0, s.minutes - waited.any),
        tokens: s.tokens ?? null,
      });
    }
  }
  const lastMerged = new Map<string, string>();
  const lastRelease = new Map<string, string>();
  const gateStart = new Map<string, string>();
  const firstFinished = new Set<string>();
  // A capacity retry's rows are left out, as its wall minutes are.
  const retried = new Set(
    events
      .filter((e) => e["event"] === "gate.end" && Number(e["exit"]) === 75)
      .map((e) => String(e["run"])),
  );
  const rowsWithTasks = new Set(
    events
      .filter((e) => e["event"] === "test.run" && String(e["task"]).startsWith("test"))
      .map((e) => `${e["run"]}\0${e["row"]}`),
  );
  for (const e of events) {
    const at = String(e["at"]);
    const ws = String(e["workspace"]);
    if (e["event"] === "pr.merged") lastMerged.set(ws, max(lastMerged.get(ws), at));
    else if (e["event"] === "release") lastRelease.set(ws, max(lastRelease.get(ws), at));
    else if (e["event"] === "gate.row" && !retried.has(String(e["run"]))) {
      const row = String(e["row"]);
      const rowKind = (e["row_kind"] as GateRowKind | undefined) ?? gateRowKind(row);
      const minutes = Number(e["duration_ms"]) / 60_000;
      items.push({ at, version: versionOf(ws), kind: "gateRow", rowKind, minutes });
      // shortcut: a skipped or covered row is the only sub-second test row; key on a skip flag if gate.row ever gets one.
      if (
        rowKind === "test" &&
        row.startsWith("test ") &&
        Number(e["duration_ms"]) >= 1000 &&
        !rowsWithTasks.has(`${e["run"]}\0${row}`)
      )
        items.push({
          at,
          version: versionOf(ws),
          kind: "testRun",
          package: row.slice("test ".length),
          minutes,
          cached: false,
          failed: e["result"] === "error",
        });
    } else if (
      e["event"] === "test.run" &&
      String(e["task"]).startsWith("test") &&
      !retried.has(String(e["run"]))
    )
      items.push({
        at,
        version: versionOf(ws),
        kind: "testRun",
        package: String(e["package"]),
        minutes: Number(e["duration_ms"]) / 60_000,
        cached: e["cached"] === true,
        failed: e["result"] === "error",
      });
    else if (e["event"] === "gate.start") gateStart.set(String(e["run"]), at);
    else if (e["event"] === "gate.end" && Number(e["exit"]) !== 75) {
      const start = gateStart.get(String(e["run"]));
      if (start)
        items.push({
          at,
          version: versionOf(ws),
          kind: "gate",
          minutes: (ms(at) - ms(start)) / 60_000,
        });
      if (!firstFinished.has(ws)) {
        firstFinished.add(ws);
        items.push({
          at,
          version: versionOf(ws),
          kind: "firstGate",
          passed: Number(e["exit"]) === 0,
        });
      }
    }
  }
  for (const [kind, last] of [
    ["leadToMerge", lastMerged],
    ["leadToRelease", lastRelease],
  ] as const)
    for (const [ws, at] of last) {
      const start = firstTurn.get(ws);
      if (start)
        items.push({
          at,
          version: versionOf(ws),
          kind,
          minutes: minutes(start, at),
          workspace: ws,
          ticket: ticketOf.get(ws) ?? ws,
        });
    }

  const kept = items.filter((i) => inRange(i.at));
  const byBucket = new Map<string, TrendItem[]>();
  const first = from ?? (kept.length ? Math.min(...kept.map((i) => ms(i.at))) : null);
  if (first !== null)
    for (let d = ms(bucketOf(first)); d <= to; d += (bucket === "week" ? 7 : 1) * DAY_MS)
      byBucket.set(bucketOf(d), []);
  for (const i of kept) byBucket.get(bucketOf(ms(i.at)))?.push(i);

  return {
    range,
    bucket,
    from: from === null ? null : new Date(from).toISOString(),
    to: now.toISOString(),
    suites: suitePercentiles(kept),
    suitesByVersion: Object.fromEntries(
      [...new Set(kept.map((i) => i.version))].map((v) => [
        v,
        suitePercentiles(kept.filter((i) => i.version === v)),
      ]),
    ),
    rows: [...byBucket].map(([b, its]) => {
      const versions = new Map<string, TrendItem[]>();
      for (const i of its) versions.set(i.version, [...(versions.get(i.version) ?? []), i]);
      return {
        bucket: b,
        ...trendSlice(its),
        byVersion: Object.fromEntries([...versions].map(([v, vi]) => [v, trendSlice(vi)])),
      };
    }),
  };
}

/**
 * Daily or weekly series over *range* (default `30d`, bucket `week`): shipped and abandoned
 * workspaces, ICM stage minutes p50/p90, lead time from the first turn to merge and to release,
 * tokens and cost by model, cache-read share, tokens per ICM stage and after the last stage, tokens
 * and cost per shipped ticket (p50, p90) with the five costliest, abandoned spend, active and wall minutes, gate runs, minutes (also by
 * row kind) and first-pass rate, and test minutes per package, each row also split by werkmeister
 * version; `suites` holds the per-package test minutes over the whole range. Reads what {@link metricsReport}
 * reads; never fetches.
 *
 * @param opts - `range`: `"7d"`, `"30d"`, `"90d"` or `"all"`; `bucket`: `"day"` or `"week"`; `workType`: only that work type's runs.
 * @returns The {@link MetricsTrends}.
 *
 * @example
 * ```ts
 * import { metricsTrends } from "werkmeister-core/sdk";
 *
 * const { rows } = await metricsTrends({ range: "90d" });
 * for (const r of rows) console.log(r.bucket, r.stages["03_implement"]?.p90Minutes, r.estUsd);
 * ```
 */
export async function metricsTrends(
  opts: { range?: MetricsRange; bucket?: TrendBucket; workType?: string } = {},
  now = new Date(),
): Promise<MetricsTrends> {
  const { range = "30d", bucket = "week", workType } = opts;
  return trendSeries(await flowInput(now), range, bucket, now, workType);
}
