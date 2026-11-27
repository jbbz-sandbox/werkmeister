/**
 * The usage snapshot close-out leaves in the workspace record (SW-206): `usage.json` for tools,
 * `usage.md` for people. The transcripts it reads are keyed by the workspace path, so once the
 * folder is removed these files are the only record of what the run cost.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sandboxRoot } from "./config.js";
import { issueIdOf } from "./issue_tracker.js";
import { firstFill, recordStageDone, stageDoneTimes } from "./metrics.js";
import {
  type ModelUsage,
  type SessionUsage,
  type UsageTotals,
  usageAndTurnsForDir,
  type WorkspaceUsage,
  // biome-ignore lint/suspicious/noImportCycles: pr_lifecycle↔sandbox.ts↔usage_snapshot; SW-411
} from "./sandbox.js";
import { runCapture } from "./tool_bins.js";
import { isTrue } from "./workspace_prompts.js";

export interface StageTiming {
  stage: string;
  finishedAt: string | null;
  minutes: number | null;
  /** Tokens of the turns in the stage's window; null for a stage never reached. Absent before SW-1100. */
  tokens?: UsageTotals | null;
}

export interface UsageSnapshot {
  schema: 1;
  workspace: string;
  ticket: string | null;
  model: string | null;
  autonomous: boolean;
  outcome: "shipped" | "abandoned";
  werkmeister: { version: string | null; commit: string | null };
  closedAt: string;
  firstTurn: string | null;
  wallClockMinutes: number | null;
  activeMinutes: number | null;
  sessionCount: number;
  turns: number;
  totals: UsageTotals;
  estUsd: number | null;
  byModel: ModelUsage[];
  sessions: SessionUsage[];
  stages: StageTiming[];
  /** Tokens of the turns after the last finished stage (PR, post-mortem): stages' tokens plus these are `totals`. */
  unstagedTokens?: UsageTotals;
  note?: string;
}

const NO_TRANSCRIPTS = "no Claude Code transcripts found for this workspace";

const tokensOf = (t: UsageTotals) => t.input + t.output + t.cacheCreation + t.cacheRead;
const minutesBetween = (a: string | null, b: string | null) =>
  a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60_000) : null;

export function formatTokens(n: number): string {
  for (const [div, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const)
    if (n >= div) return `${(n / div).toFixed(1)}${unit}`;
  return String(n);
}

const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);

export function usageSummary(s: UsageSnapshot): string {
  if (!s.sessionCount) return "Usage: no transcripts found";
  const cost = s.estUsd == null ? "cost unknown" : `~${usd(s.estUsd)}`;
  return `Usage: ${formatTokens(tokensOf(s.totals))} tokens, ${cost} across ${s.sessionCount} session${s.sessionCount === 1 ? "" : "s"}`;
}

/**
 * Each `stages/NN_*` finished at its `stage.done` event, else the record commit that first filled
 * its output (SW-777); its oldest output mtime only when no commit has. Never the newest mtime:
 * re-editing an earlier stage's file later made the next stage's minutes negative (SW-774).
 */
export function stageTimings(ws: string, firstTurn: string | null): StageTiming[] {
  const root = path.join(ws, "stages");
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const oldest = (dir: string): number => {
    let min = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const t = e.isDirectory() ? oldest(p) : e.name === ".gitkeep" ? 0 : fs.statSync(p).mtimeMs;
      if (t && (!min || t < min)) min = t;
    }
    return min;
  };
  const events = stageDoneTimes(ws);
  let prev = firstTurn;
  return dirs.map((stage) => {
    const mtime = () => oldest(path.join(root, stage, "output"));
    const at = events.get(stage) ?? firstFill(ws, stage)?.at;
    const ms = at ? Date.parse(at) : mtime();
    const finishedAt = ms ? new Date(ms).toISOString() : null;
    const minutes = finishedAt ? minutesBetween(prev, finishedAt) : null;
    // A stage committed before the one ahead of it counts 0 minutes, and the clock never runs back.
    if (finishedAt && (!prev || ms > Date.parse(prev))) prev = finishedAt;
    return { stage, finishedAt, minutes: minutes == null ? null : Math.max(0, minutes) };
  });
}

const zeroTotals = (): UsageTotals => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

/**
 * Split *turns* (`[ms, tokens]`) over *stages* (from {@link stageTimings}): each turn counts in the
 * first reached stage ending at or after it; turns after the last end are `unstaged`. Ends never run
 * back, as in `stageTimings`, so a stage committed before the one ahead of it gets zero.
 */
export function stageTokens(
  stages: StageTiming[],
  turns: Array<[number, UsageTotals]>,
): { stages: StageTiming[]; unstaged: UsageTotals } {
  let end = -Infinity;
  const windows = stages.map((s) => {
    if (s.finishedAt) end = Math.max(end, Date.parse(s.finishedAt));
    return { stage: { ...s, tokens: s.finishedAt ? zeroTotals() : null }, end };
  });
  const unstaged = zeroTotals();
  for (const [at, t] of turns) {
    const into = windows.find((w) => w.stage.tokens && at <= w.end)?.stage.tokens ?? unstaged;
    for (const k of Object.keys(into) as (keyof UsageTotals)[]) into[k] += t[k];
  }
  return { stages: windows.map((w) => w.stage), unstaged };
}

async function werkmeisterBuild(): Promise<{ version: string | null; commit: string | null }> {
  let root: string;
  try {
    root = sandboxRoot();
  } catch {
    return { version: null, commit: null };
  }
  let version: string | null = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null;
  } catch {}
  // Only a dev link (a checkout) has a commit; an npm install has just the version.
  const rev = await runCapture("git", ["-C", root, "rev-parse", "--short", "HEAD"]).catch(
    () => null,
  );
  return { version, commit: rev?.code === 0 ? rev.stdout.trim() || null : null };
}

export async function buildUsageSnapshot(
  ws: string,
  name: string,
  cfg: Record<string, unknown>,
  outcome: UsageSnapshot["outcome"],
  closedAt = new Date().toISOString(),
): Promise<UsageSnapshot> {
  let usage: WorkspaceUsage;
  let turns: Array<[number, UsageTotals]> = [];
  let note: string | undefined;
  try {
    ({ usage, turns } = await usageAndTurnsForDir(name, ws));
  } catch (e) {
    // Close-out must not fail over a report.
    usage = {
      name,
      totals: zeroTotals(),
      estUsd: null,
      activeMinutes: null,
      byModel: [],
      sessions: [],
    };
    note = `usage not read: ${(e as Error).message}`;
  }
  if (!usage.sessions.length) note ??= NO_TRANSCRIPTS;
  const firstTurn =
    usage.sessions
      .map((s) => s.firstTurn)
      .filter((t): t is string => !!t)
      .sort()[0] ?? null;
  // Catches stage commits no hook saw (made by hand, or with hooks off) before stage times are read.
  recordStageDone(ws);
  const split = stageTokens(stageTimings(ws, firstTurn), turns);
  const model =
    typeof cfg["model"] === "string" && cfg["model"].trim() ? cfg["model"].trim() : null;
  return {
    schema: 1,
    workspace: name,
    ticket: issueIdOf(cfg) || null,
    model,
    autonomous: isTrue(cfg["autonomous"]),
    outcome,
    werkmeister: await werkmeisterBuild(),
    closedAt,
    firstTurn,
    wallClockMinutes: minutesBetween(firstTurn, closedAt),
    activeMinutes: usage.activeMinutes,
    sessionCount: usage.sessions.length,
    turns: usage.sessions.reduce((n, s) => n + s.turns, 0),
    totals: usage.totals,
    estUsd: usage.estUsd,
    byModel: usage.byModel,
    sessions: usage.sessions,
    stages: split.stages,
    unstagedTokens: split.unstaged,
    ...(note ? { note } : {}),
  };
}

export function renderUsageMd(s: UsageSnapshot): string {
  const cell = (v: unknown) =>
    v === null || v === undefined || v === "" ? "—" : String(v).replace(/\|/g, "\\|");
  const n = (v: number) => v.toLocaleString("en-US");
  const tokenCells = (t: UsageTotals) =>
    `${n(t.input)} | ${n(t.output)} | ${n(t.cacheCreation)} | ${n(t.cacheRead)}`;
  const table = (head: string, rows: string[]) => (rows.length ? [head, ...rows] : ["None."]);
  const build = [s.werkmeister.version, s.werkmeister.commit && `(${s.werkmeister.commit})`]
    .filter(Boolean)
    .join(" ");
  return [
    "# Usage",
    "",
    usageSummary(s),
    "",
    `- Workspace: ${s.workspace}`,
    `- Ticket: ${cell(s.ticket)}`,
    `- Outcome: ${s.outcome}`,
    `- Model: ${cell(s.model)}`,
    `- Autonomous: ${s.autonomous}`,
    `- werkmeister: ${cell(build)}`,
    `- Closed: ${s.closedAt}`,
    `- First turn: ${cell(s.firstTurn)}`,
    `- Wall clock: ${s.wallClockMinutes == null ? "—" : `${s.wallClockMinutes} min`}`,
    `- Active: ${s.activeMinutes == null ? "—" : `${s.activeMinutes} min`}`,
    `- Sessions: ${s.sessionCount}`,
    `- Turns: ${s.turns}`,
    ...(s.note ? ["", `Note: ${s.note}`] : []),
    "",
    "## Tokens by model",
    "",
    ...table(
      "| model | input | output | cache write | cache read | est. USD |\n|---|---|---|---|---|---|",
      [
        ...s.byModel.map(
          (m) => `| ${cell(m.model)} | ${tokenCells(m.totals)} | ${usd(m.estUsd)} |`,
        ),
        ...(s.byModel.length ? [`| **total** | ${tokenCells(s.totals)} | ${usd(s.estUsd)} |`] : []),
      ],
    ),
    "",
    "## Sessions",
    "",
    ...table(
      "| session | title | first turn | last turn | turns | tokens | model(s) | est. USD |\n|---|---|---|---|---|---|---|---|",
      s.sessions.map(
        (x) =>
          `| ${x.sessionId} | ${cell(x.title)} | ${cell(x.firstTurn)} | ${cell(x.lastTurn)} | ${x.turns} | ${formatTokens(tokensOf(x.totals))} | ${cell(x.models.join(", "))} | ${usd(x.estUsd)} |`,
      ),
    ),
    "",
    "## Stages (from each stage's stage.done event, else its first output commit)",
    "",
    ...table("| stage | finished | minutes | tokens |\n|---|---|---|---|", [
      ...s.stages.map(
        (t) =>
          `| ${t.stage} | ${t.finishedAt ?? "not reached"} | ${cell(t.minutes)} | ${t.tokens ? formatTokens(tokensOf(t.tokens)) : "—"} |`,
      ),
      ...(s.unstagedTokens
        ? [`| after stages | — | — | ${formatTokens(tokensOf(s.unstagedTokens))} |`]
        : []),
    ]),
    "",
  ].join("\n");
}

/**
 * Write `usage.json` + `usage.md` into *ws* and return the closeout.md summary line. A retry
 * (removal failed after the first run) keeps the first snapshot rather than re-reading later transcripts.
 */
export async function writeUsageSnapshot(
  ws: string,
  name: string,
  cfg: Record<string, unknown>,
  outcome: UsageSnapshot["outcome"],
): Promise<string> {
  const jsonFile = path.join(ws, "usage.json");
  if (fs.existsSync(jsonFile)) {
    try {
      return `${usageSummary(JSON.parse(fs.readFileSync(jsonFile, "utf8")))}; see usage.md`;
    } catch {
      return "Usage: see usage.md";
    }
  }
  const snapshot = await buildUsageSnapshot(ws, name, cfg, outcome);
  fs.writeFileSync(path.join(ws, "usage.md"), renderUsageMd(snapshot));
  fs.writeFileSync(jsonFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return `${usageSummary(snapshot)}; see usage.md`;
}
