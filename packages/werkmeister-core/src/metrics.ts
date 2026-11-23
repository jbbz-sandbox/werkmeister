/**
 * The metrics event log (SW-775, design SW-772 § Q3, Q4): `~/.werkmeister/metrics/events-YYYY-MM.jsonl`,
 * append-only, local only, kept forever. One line per event, shaped by
 * `docs/superpowers/specs/2026-11-15-metrics-events.schema.json`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { sandboxHome } from "./config.js";
import { dotDir } from "./dot_dir.js";
import { warn } from "./reporter.js";

export type MetricsEvent =
  /** *reason*: which writer queued it, "preempted", "requeued" or "waiting for capacity" (SW-991). */
  | { event: "queue.wait"; workspace: string; feature: string; position: number; reason?: string }
  | { event: "queue.admit"; workspace: string; feature: string; waited_s: number }
  /** *feature* was stopped to make room for *for*; *rank* is what admission read it as (SW-989). */
  | { event: "queue.preempt"; workspace: string; feature: string; rank: string; for: string }
  | { event: "pr.open" | "pr.merged"; workspace: string; ticket?: string; pr: string }
  | { event: "release"; workspace: string; ticket?: string; pr: string; tag: string }
  | { event: "gate.start"; workspace: string; run: string; retry: number }
  | { event: "gate.end"; workspace: string; run: string; exit: number }
  | { event: "stage.done"; workspace: string; stage: string; commit: string }
  /** `werkmeister issue start` moved *ticket* to in progress; where cycle time starts (SW-1034). */
  | { event: "issue.start"; workspace: string; ticket: string }
  | { event: "ask"; workspace: string; session: string; kind: "question" | "plan" | "wrap-up" }
  | { event: "answer"; workspace: string; session: string; waited_s: number };

/** `<sandboxHome()>/metrics/events-YYYY-MM.jsonl`, the UTC month of *at* (an ISO time). */
export function metricsPath(at: string): string {
  return path.join(sandboxHome(), "metrics", `events-${at.slice(0, 7)}.jsonl`);
}

/** `<sandboxHome()>/metrics/usage-branches.jsonl`: every record branch's `usage.json` plus its author `by`, rewritten by `metrics rebuild` (SW-1104). */
export const usageCachePath = () => path.join(sandboxHome(), "metrics", "usage-branches.jsonl");

/** Appends *e* to this month's log; false when it could not. A failure warns and never throws: a lost metric must not fail its caller. */
export function recordEvent(e: MetricsEvent, at = new Date().toISOString()): boolean {
  const file = metricsPath(at);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One appendFileSync is one write() on an O_APPEND file, so concurrent writers' lines don't interleave.
    fs.appendFileSync(file, `${JSON.stringify({ v: 1, at, ...e })}\n`);
    return true;
  } catch (err) {
    warn(`metrics: could not record ${e.event}: ${(err as Error).message}`);
    return false;
  }
}

/** *file* at the tip of each of *branches* in *repo*, by branch; a branch without it is left out. One git call; warns and returns what it has on failure. */
export function branchFiles(repo: string, branches: string[], file: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!branches.length) return out;
  const batch = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: branches.map((b) => `${b}:${file}\n`).join(""),
    maxBuffer: 1 << 28,
  });
  if (batch.status !== 0) {
    warn(`metrics: could not read ${file} from record branches: ${batch.stderr}`);
    return out;
  }
  // Raw bytes: each reply's size is in bytes. A reply is "<sha> blob <size>\n<body>\n", or "<rev> missing\n", in input order.
  const buf = batch.stdout;
  let i = 0;
  for (const branch of branches) {
    const eol = buf.indexOf(10, i);
    if (eol < 0) break;
    const header = buf.toString("utf8", i, eol).split(" ");
    i = eol + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    out.set(branch, buf.toString("utf8", i, i + size));
    i += size + 1;
  }
  return out;
}

/** The commit on *rev* (default HEAD) that first added a file other than `.gitkeep` under `stages/<stage>/output/`, or null. */
export function firstFill(
  ws: string,
  stage: string,
  rev?: string,
): { commit: string; at: string } | null {
  const out = `stages/${stage}/output`;
  const r = spawnSync(
    "git",
    [
      "-C",
      ws,
      "log",
      ...(rev ? [rev] : []),
      "--diff-filter=A",
      "--format=%H %cI",
      "--",
      out,
      `:!${out}/.gitkeep`,
    ],
    { encoding: "utf8" },
  );
  const line = r.status === 0 ? r.stdout.trim().split("\n").pop() : ""; // newest first
  if (!line) return null;
  const [commit = "", at = ""] = line.split(" ");
  return { commit, at: new Date(at).toISOString() };
}

/** `<ws>/.werkmeister/stage-done/`: one empty file per stage whose `stage.done` is written. */
export const stageDoneDir = (ws: string) => path.join(dotDir(ws), "stage-done");

/**
 * Writes `stage.done` for each stage whose output/ was first filled by a commit and has none yet
 * (SW-777). Run from the agent-state hook after every tool call and at close-out, since the agent
 * makes the commit itself; `at` is the commit's time, so a late sweep is still exact.
 */
export function recordStageDone(ws: string): void {
  try {
    const root = path.join(ws, "stages");
    if (!fs.existsSync(root)) return;
    let done: Map<string, string> | undefined;
    for (const stage of fs
      .readdirSync(root)
      .filter((d) => /^\d+_/.test(d))
      .sort()) {
      const claim = path.join(stageDoneDir(ws), stage);
      if (fs.existsSync(claim)) continue;
      let filled = false;
      try {
        filled = fs.readdirSync(path.join(root, stage, "output")).some((f) => f !== ".gitkeep");
      } catch {}
      // Only a filled output/ spawns git, so a run whose stages are all claimed costs readdirs only.
      const fill = filled ? firstFill(ws, stage) : null;
      if (!fill) continue;
      fs.mkdirSync(stageDoneDir(ws), { recursive: true });
      try {
        // "wx" fails when the file exists: of parallel tool calls' hooks, one claims the stage.
        fs.closeSync(fs.openSync(claim, "wx"));
      } catch {
        continue;
      }
      // `metrics rebuild` logs stage.done without a claim (SW-1025): don't add a second line.
      // Checked only here, for a filled, unclaimed stage, so it stays off the hot path.
      done ??= stageDoneTimes(ws);
      // shortcut: keyed on stage, not commit, as stageDoneTimes is; a refilled stage is not re-logged.
      if (done.has(stage)) continue;
      recordEvent(
        { event: "stage.done", workspace: path.basename(ws), stage, commit: fill.commit },
        fill.at,
      );
    }
  } catch (err) {
    warn(`metrics: could not record stage.done: ${(err as Error).message}`);
  }
}

/**
 * The log lines of *ws*'s current run, oldest month first. The log keys events by workspace name,
 * so a `stage.done` counts only when its commit is in *ws*'s history: a reused name's earlier run is
 * not this one.
 */
function* runLines(ws: string): Generator<{ line: string; e: Record<string, unknown> }> {
  const workspace = path.basename(ws);
  const dir = path.join(sandboxHome(), "metrics");
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /^events-.*\.jsonl$/.test(f))
      .sort();
  } catch {
    return;
  }
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.["workspace"] !== workspace) continue;
      if (e["event"] === "stage.done") {
        const commit = String(e["commit"]);
        const ancestor = spawnSync("git", [
          "-C",
          ws,
          "merge-base",
          "--is-ancestor",
          commit,
          "HEAD",
        ]);
        if (ancestor.status !== 0) continue;
      }
      yield { line, e };
    }
  }
}

/** *ws*'s `stage.done` times by stage, for its current run. */
export function stageDoneTimes(ws: string): Map<string, string> {
  const times = new Map<string, string>();
  for (const { e } of runLines(ws))
    if (e["event"] === "stage.done") times.set(String(e["stage"]), String(e["at"]));
  return times;
}

/**
 * *ws*'s run as raw log lines, for close-out to push as `metrics.jsonl` on the record branch
 * (SW-1104). Verbatim, so its owner's `metrics rebuild` drops them as already logged.
 */
export function workspaceSlice(ws: string): string[] {
  return [...runLines(ws)].map((r) => r.line);
}
