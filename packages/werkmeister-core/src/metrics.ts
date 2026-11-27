/**
 * The metrics event log (SW-775, design SW-772 § Q3, Q4): `~/.werkmeister/metrics/events-YYYY-MM.jsonl`,
 * append-only, local only, kept forever. One line per event, shaped by
 * `docs/superpowers/specs/2026-11-15-metrics-events.schema.json`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { sandboxHome } from "./config.js";
import { dotDir } from "./dot_dir.js";
import { currentLogger, machineLogPath, scrub, slowCallKind, workspaceLogPath } from "./logger.js";
import { warn } from "./reporter.js";

export type TimedEvent =
  | "workspace.create"
  | "workspace.init"
  | "workspace.up"
  | "workspace.down"
  | "workspace.pause"
  | "workspace.resume"
  | "workspace.close"
  | "workspace.abandon";
export type SlowCall = "docker build" | "install" | "git fetch" | "tracker";
type Result = "ok" | "error";

/**
 * What a gate row does, for the Metrics tab's stacked gate minutes (`SW-1101`).
 *
 * @example
 * ```ts
 * import { type GateRowKind, metricsTrends } from "werkmeister-core/sdk";
 *
 * const { rows } = await metricsTrends();
 * const kind: GateRowKind = "test";
 * for (const r of rows) console.log(r.bucket, r.gate.byKind[kind]);
 * ```
 */
export type GateRowKind = "setup" | "lint" | "test" | "release" | "checks";

/** *row*'s kind from its name; also read-side for `gate.row` lines from before `row_kind`. */
export function gateRowKind(row: string): GateRowKind {
  if (["containers", "memory", "registry"].includes(row) || row.startsWith("start "))
    return "setup";
  if (row === "lint" || row === "release") return row;
  if (row === "tests" || row.startsWith("test ")) return "test";
  return "checks";
}

/** *run_id*: the writing run's id from its workspace.yml ({@link runTag}), so same-named runs' lines stay apart (SW-1140). */
export type MetricsEvent = EventBody & { run_id?: string };

type EventBody =
  /** *reason*: which writer queued it, "preempted", "requeued", "waiting for capacity" (SW-991) or "waiting for host load" (SW-1236). */
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
  | { event: "answer"; workspace: string; session: string; waited_s: number }
  /**
   * SW-404: how long a workspace verb, a gate row or a slow external call took. *work_type*: workspace.create
   * and workspace.init only, the run's `workspace.yml` value after the step (SW-1212).
   */
  | {
      event: TimedEvent;
      workspace: string;
      duration_ms: number;
      result: Result;
      work_type?: string;
    }
  | {
      event: "gate.row";
      workspace: string;
      run: string;
      row: string;
      duration_ms: number;
      result: Result;
      row_kind: GateRowKind;
      /** Host-load wait before the row's one retry, left out of *duration_ms* (SW-1101). */
      wait_ms?: number;
    }
  /** One turbo task a gate row ran (SW-1101), from turbo's run summary; *tests* and *failures* from the package's `coverage/run.json`. */
  | {
      event: "test.run";
      workspace: string;
      run: string;
      row: string;
      package: string;
      task: string;
      duration_ms: number;
      result: Result;
      cached: boolean;
      tests?: number;
      failures?: number;
    }
  | { event: "call.slow"; workspace: string; cmd: SlowCall; duration_ms: number; result: Result }
  /** SW-1172: `feature up` found every container of the set healthy, *duration_ms* after the up began. */
  | { event: "containers.healthy"; workspace: string; duration_ms: number }
  /** SW-1172: a PR's checks on head *commit* all finished; *duration_ms* from the first check's start to the last one's end, when GitHub gives both. */
  | {
      event: "ci.result";
      workspace: string;
      ticket?: string;
      pr: string;
      commit: string;
      result: Result;
      duration_ms?: number;
    }
  /** SW-1172: a Claude session in the workspace started (new, or resumed after it ended) or ended. */
  | { event: "session.start" | "session.stop"; workspace: string; session: string }
  /** One package's unit-test coverage for one run (SW-405); a CI row has no workspace. *version* is `<package version>+<short sha>`. */
  | {
      event: "coverage";
      workspace?: string;
      source: "ci-main" | "ci-pr" | "gate";
      commit: string;
      run?: string;
      package: string;
      version?: string;
      lines: number;
      branches: number;
      functions: number;
      statements: number;
      tests?: number;
      failures?: number;
      duration_ms?: number;
    };

/** `<sandboxHome()>/metrics/events-YYYY-MM.jsonl`, the UTC month of *at* (an ISO time). */
export function metricsPath(at: string): string {
  return path.join(sandboxHome(), "metrics", `events-${at.slice(0, 7)}.jsonl`);
}

/** `<sandboxHome()>/metrics/usage-branches.jsonl`: every record branch's `usage.json` plus its author `by`, rewritten by `metrics rebuild` (SW-1104). */
export const usageCachePath = () => path.join(sandboxHome(), "metrics", "usage-branches.jsonl");

/** `{ run_id }` of the workspace at *ws*, to spread into an event; `{}` with no path or no id (a workspace from before SW-1140). Never throws. */
export function runTag(ws: string): { run_id?: string } {
  // No path: dotDir("") would read the cwd's workspace.yml, another run's.
  if (!ws) return {};
  try {
    // workspace.yml alone: writeWorkspaceConfig writes run_id only there. Not workspace_prompts: an import cycle.
    return runTagOf(fs.readFileSync(path.join(dotDir(ws), "workspace.yml"), "utf8"));
  } catch {
    return {};
  }
}

/** {@link runTag} from a workspace.yml's text, e.g. one read off a record branch (SW-1158). Never throws. */
export function runTagOf(yml: string | undefined): { run_id?: string } {
  let id: unknown;
  try {
    id = YAML.parse(yml ?? "")?.run_id;
  } catch {}
  return typeof id === "string" && id ? { run_id: id } : {};
}

/** A run whose work type nothing recorded (SW-1212); never guessed from the branch or the issue. */
export const WORK_TYPE_UNKNOWN = "unknown";

/** A workspace.yml's `work_type`, trimmed and lowercased, or undefined when it has none. Never throws. */
export function workTypeOf(yml: string | undefined): string | undefined {
  let wt: unknown;
  try {
    wt = YAML.parse(yml ?? "")?.work_type;
  } catch {}
  const t = typeof wt === "string" ? wt.trim().toLowerCase() : "";
  return t || undefined;
}

/** `{ work_type }` of the workspace at *ws*, to spread into an event; `{}` with none. Never throws. */
function workTypeTag(ws: string): { work_type?: string } {
  if (!ws) return {};
  let yml: string | undefined;
  try {
    yml = fs.readFileSync(path.join(dotDir(ws), "workspace.yml"), "utf8");
  } catch {}
  const work_type = workTypeOf(yml);
  return work_type ? { work_type } : {};
}

/** The log bindings that name the workspace at *ws* (SW-404): folder name, run id, ticket and current ICM stage. Never throws. */
export function workspaceBindings(ws: string): {
  workspace: string;
  run_id?: string;
  ticket?: string;
  stage?: string;
} {
  let yml: Record<string, unknown> = {};
  try {
    yml = YAML.parse(fs.readFileSync(path.join(dotDir(ws), "workspace.yml"), "utf8")) ?? {};
  } catch {}
  // issue_tracker's issueIdOf, inlined: importing it cycles back here through the Jira tracker.
  const ticket = [yml["issue_id"], yml["jira_id"], yml["github_issue"]].find(
    (v) => typeof v === "string" && v,
  ) as string | undefined;
  // sandbox.ts icmStage's rule, sync: the first stage whose output/ holds no visible file.
  let stage: string | undefined;
  try {
    for (const s of fs
      .readdirSync(path.join(ws, "stages"))
      .filter((n) => /^\d+_/.test(n))
      .sort()) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(ws, "stages", s, "output"));
      } catch {}
      if (!files.some((f) => !f.startsWith("."))) {
        stage = s;
        break;
      }
    }
  } catch {}
  return { workspace: path.basename(ws), ...runTag(ws), ticket, stage };
}

/** Appends *e* to this month's log; false when it could not. A failure warns and never throws: a lost metric must not fail its caller. */
export function recordEvent(e: MetricsEvent, at = new Date().toISOString()): boolean {
  return appendLogLine(JSON.stringify({ v: 1, at, ...e }), at, e.event);
}

/** Records *event* for the workspace at *ws*, timed from *startMs* (SW-404). */
export function recordTimed(
  event: TimedEvent,
  ws: string,
  startMs: number,
  result: Result,
  tag = runTag(ws),
): void {
  recordEvent({
    event,
    workspace: path.basename(ws),
    duration_ms: Date.now() - startMs,
    result,
    ...tag,
    // Read now, after the step: an init that changes work_type logs the new one (SW-1212).
    ...(event === "workspace.create" || event === "workspace.init" ? workTypeTag(ws) : {}),
  });
}

/** Runs *fn* and records *event* with its wall time and whether it threw. */
export async function timed<T>(event: TimedEvent, ws: string, fn: () => Promise<T>): Promise<T> {
  // Read first: close-out removes the folder, and its workspace.yml with the run id.
  const tag = runTag(ws);
  const start = Date.now();
  let result: Result = "error";
  try {
    const out = await fn();
    result = "ok";
    return out;
  } finally {
    recordTimed(event, ws, start, result, tag);
  }
}

export const SLOW_CALL_MS = 5000;

/** A tracked call of *kind* that took *duration_ms*: an info line, and `call.slow` when a workspace is bound (the schema requires one). */
export function noteSlow(kind: SlowCall, duration_ms: number, result: Result): void {
  if (duration_ms < SLOW_CALL_MS) return;
  const log = currentLogger();
  log.info({ cmd: kind, duration_ms, result }, "slow call");
  const { workspace, run_id } = log.bindings();
  if (typeof workspace === "string")
    recordEvent({
      event: "call.slow",
      workspace,
      cmd: kind,
      duration_ms,
      result,
      ...(run_id ? { run_id } : {}),
    });
}

/**
 * After an external call ends: a non-zero exit is a `warn` with its exit code and stderr tail (not `error`: many
 * callers probe and expect failures, and the default level must not fill with them), and a slow tracked call is noted.
 */
export function noteCall(
  bin: string,
  args: readonly string[],
  cwd: string | undefined,
  status: number | null,
  stderr: string,
  startMs: number,
): void {
  if (status !== 0)
    currentLogger().warn(
      {
        bin: path.basename(bin),
        args: args.slice(0, 3),
        cwd,
        code: status,
        stderrTail: stderr.slice(-2048),
      },
      "external call failed",
    );
  const kind = slowCallKind(bin, args);
  if (kind) noteSlow(kind, Date.now() - startMs, status === 0 ? "ok" : "error");
}

/** Lines of the machine log (the capped `.1` file first) that belong to the run at *ws*: its `run_id`, or its name on untagged lines. */
export function workspaceLogSlice(ws: string): string[] {
  const workspace = path.basename(ws);
  const { run_id } = runTag(ws);
  const current = machineLogPath();
  const out: string[] = [];
  for (const file of [current.replace(/\.jsonl$/, ".1.jsonl"), current]) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      let e: Record<string, unknown> | null = null;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.["run_id"] !== undefined ? e["run_id"] === run_id : e?.["workspace"] === workspace)
        out.push(line);
    }
  }
  return out;
}

/**
 * Close-out (SW-404): `<ws>/logs/werkmeister.jsonl`, the workspace's own log plus this run's machine-log lines,
 * by time, scrubbed again since the record branch is pushed. False when there was nothing to write.
 */
export function writeLogRecord(ws: string): boolean {
  let own: string[] = [];
  try {
    own = fs.readFileSync(workspaceLogPath(ws), "utf8").split("\n");
  } catch {}
  const timeOf = (l: string) => {
    try {
      return String(JSON.parse(l).time ?? "");
    } catch {
      return "";
    }
  };
  const lines = [...own.filter(Boolean), ...workspaceLogSlice(ws)].sort((a, b) =>
    timeOf(a).localeCompare(timeOf(b)),
  );
  if (!lines.length) return false;
  const file = path.join(ws, "logs", "werkmeister.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map(scrub).join("\n")}\n`);
  return true;
}

/** Appends one already-serialised *line* of *event* to the log of *at*'s month; as {@link recordEvent}, warns and returns false on failure. */
export function appendLogLine(line: string, at: string, event: string): boolean {
  const file = metricsPath(at);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // One appendFileSync is one write() on an O_APPEND file, so concurrent writers' lines don't interleave.
    fs.appendFileSync(file, `${line}\n`);
    return true;
  } catch (err) {
    warn(`metrics: could not record ${event}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * *file* at the tip of each of *branches* in *repo*, by branch; a branch without it is left out. One git call.
 * Null when the read failed (warned), so a caller can tell it from "no branch has it" (SW-1127).
 */
export function branchFiles(
  repo: string,
  branches: string[],
  file: string,
): Map<string, string> | null {
  const out = new Map<string, string>();
  if (!branches.length) return out;
  const batch = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: branches.map((b) => `${b}:${file}\n`).join(""),
    maxBuffer: 1 << 28,
  });
  if (batch.status !== 0) {
    warn(
      `metrics: could not read ${file} from record branches: ${batch.stderr?.toString().trim() || batch.error?.message}`,
    );
    return null;
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
        {
          event: "stage.done",
          workspace: path.basename(ws),
          stage,
          commit: fill.commit,
          ...runTag(ws),
        },
        fill.at,
      );
    }
  } catch (err) {
    warn(`metrics: could not record stage.done: ${(err as Error).message}`);
  }
}

/** Author time (ms) of the oldest commit on *ws*'s record branch that its base lacks; null with no base or no own commit. */
function runStart(ws: string): number | null {
  // Local refs only: this runs from the agent-state hook, which must not reach the network (baseRef can).
  const base = ["origin/HEAD", "origin/main", "origin/master"].find(
    (ref) => spawnSync("git", ["-C", ws, "rev-parse", "--verify", "--quiet", ref]).status === 0,
  );
  if (!base) return null;
  // Author time: a rebase or amend resets the committer time to now, and would drop the run's earlier lines.
  const r = spawnSync("git", ["-C", ws, "log", "--format=%aI", `${base}..HEAD`], {
    encoding: "utf8",
  });
  const first = r.status === 0 ? r.stdout.trim().split("\n").pop() : ""; // newest first
  return first ? Date.parse(first) : null;
}

/**
 * The log lines of *ws*'s current run, oldest month first. A line with a `run_id` is this run's
 * only when it is *ws*'s run id (SW-1140): a teammate's run or a reused name's earlier one has its own.
 * A line without one (written before SW-1140) is matched by workspace name: one older than the
 * record branch's first commit is left out (SW-1116), and a `stage.done` counts only when its commit
 * is in *ws*'s history. With no first commit to go by (no origin, or no commit of its own), every
 * untagged line of the name counts.
 */
function* runLines(ws: string): Generator<{ line: string; e: Record<string, unknown> }> {
  const workspace = path.basename(ws);
  const { run_id } = runTag(ws);
  const start = runStart(ws);
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
      if (e["run_id"] !== undefined) {
        if (e["run_id"] === run_id) yield { line, e };
        continue;
      }
      if (start !== null && !(Date.parse(String(e["at"])) >= start)) continue;
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
