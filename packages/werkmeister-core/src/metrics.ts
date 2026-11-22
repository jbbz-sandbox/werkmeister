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
  | { event: "queue.wait"; workspace: string; feature: string; position: number }
  | { event: "queue.admit"; workspace: string; feature: string; waited_s: number }
  /** *feature* was stopped to make room for *for*; *rank* is what admission read it as (SW-989). */
  | { event: "queue.preempt"; workspace: string; feature: string; rank: string; for: string }
  | { event: "pr.open" | "pr.merged"; workspace: string; ticket?: string; pr: string }
  | { event: "release"; workspace: string; ticket?: string; pr: string; tag: string }
  | { event: "gate.start"; workspace: string; run: string; retry: number }
  | { event: "gate.end"; workspace: string; run: string; exit: number }
  | { event: "stage.done"; workspace: string; stage: string; commit: string }
  | { event: "ask"; workspace: string; session: string; kind: "question" | "plan" | "wrap-up" }
  | { event: "answer"; workspace: string; session: string; waited_s: number };

/** `<sandboxHome()>/metrics/events-YYYY-MM.jsonl`, the UTC month of *at* (an ISO time). */
export function metricsPath(at: string): string {
  return path.join(sandboxHome(), "metrics", `events-${at.slice(0, 7)}.jsonl`);
}

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
 * *ws*'s `stage.done` times by stage. The log keys events by workspace name, so an event counts
 * only when its commit is in *ws*'s history: a reused name's earlier run is not this one.
 */
export function stageDoneTimes(ws: string): Map<string, string> {
  const times = new Map<string, string>();
  const workspace = path.basename(ws);
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(path.join(sandboxHome(), "metrics"))
      .filter((f) => /^events-.*\.jsonl$/.test(f));
  } catch {
    return times;
  }
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(sandboxHome(), "metrics", f), "utf8");
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
      if (e["event"] !== "stage.done" || e["workspace"] !== workspace) continue;
      const commit = String(e["commit"]);
      const ancestor = spawnSync("git", ["-C", ws, "merge-base", "--is-ancestor", commit, "HEAD"]);
      if (ancestor.status === 0) times.set(String(e["stage"]), String(e["at"]));
    }
  }
  return times;
}
