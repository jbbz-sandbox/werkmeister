/**
 * Per-task test timing for the gate (SW-1101): the gate runs each row with `TURBO_RUN_SUMMARY=true`,
 * and turbo (2.x) writes `<repo>/.turbo/runs/<id>.json` with every task's start, end, exit and cache
 * status. Each task becomes one `test.run` event; a row that runs no turbo writes none.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { type MetricsEvent, recordEvent } from "./metrics.js";
import { warn } from "./reporter.js";

export interface TurboTask {
  package: string;
  task: string;
  /** The package folder, relative to the repo root. */
  directory: string;
  startTime: number;
  endTime: number;
  exitCode: number;
  cached: boolean;
}

export interface TestRunCtx {
  workspace: string;
  run: string;
  row: string;
  run_id?: string;
}

/** Tasks of every `<repoDir>/.turbo/runs/*.json` written at or after *sinceMs*, which it then deletes. Never throws. */
export function readTurboTasks(repoDir: string, sinceMs: number): TurboTask[] {
  const dir = path.join(repoDir, ".turbo", "runs");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: TurboTask[] = [];
  const fresh = files
    .map((f) => path.join(dir, f))
    .flatMap((file) => {
      try {
        // Whole seconds on some bind mounts (as coverage.ts): a summary written in the row's first second reads older.
        const mtime = fs.statSync(file).mtimeMs;
        return mtime >= Math.floor(sinceMs / 1000) * 1000 ? [{ file, mtime }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  for (const { file } of fresh) {
    try {
      const summary = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const t of summary.tasks ?? []) {
        const e = t.execution;
        if (typeof t.package !== "string" || typeof t.task !== "string" || !e) continue;
        out.push({
          package: t.package,
          task: t.task,
          directory: typeof t.directory === "string" ? t.directory : "",
          startTime: Number(e.startTime),
          endTime: Number(e.endTime),
          exitCode: Number(e.exitCode),
          cached: t.cache?.status === "HIT",
        });
      }
    } catch (err) {
      warn(`test timing: skipped ${file}: ${(err as Error).message}`);
    }
    // Read once: the next row's run must not count these tasks again. A file the host can't remove (written as
    // root in the container) is left, never thrown: this runs bare before a row's retry.
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
  return out;
}

const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** One `test.run` per task, turbo's root `//` tasks left out; an uncached test task takes its counts from a fresh `coverage/run.json`. */
export function testRunRows(
  tasks: TurboTask[],
  repoDir: string,
  ctx: TestRunCtx,
  sinceMs: number,
): MetricsEvent[] {
  return tasks
    .filter((t) => t.package !== "//" && t.endTime >= t.startTime)
    .map((t) => {
      let counts: { tests?: unknown; failures?: unknown } = {};
      if (t.task.startsWith("test") && !t.cached) {
        const file = path.join(repoDir, t.directory, "coverage", "run.json");
        try {
          // An older run.json measured another run.
          if (fs.statSync(file).mtimeMs >= Math.floor(sinceMs / 1000) * 1000)
            counts = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
      }
      return {
        event: "test.run" as const,
        workspace: ctx.workspace,
        run: ctx.run,
        row: ctx.row,
        package: t.package,
        task: t.task,
        duration_ms: t.endTime - t.startTime,
        result: t.exitCode === 0 ? ("ok" as const) : ("error" as const),
        cached: t.cached,
        ...(count(counts.tests) && { tests: counts.tests }),
        ...(count(counts.failures) && { failures: counts.failures }),
        ...(ctx.run_id && { run_id: ctx.run_id }),
      };
    });
}

/** Records the `test.run` events of the turbo runs a gate row made since *sinceMs*; how many. Never throws. */
export function recordTestRuns(repoDir: string, sinceMs: number, ctx: TestRunCtx): number {
  try {
    return testRunRows(readTurboTasks(repoDir, sinceMs), repoDir, ctx, sinceMs).filter((e) =>
      recordEvent(e),
    ).length;
  } catch (e) {
    warn(`test timing: ${(e as Error).message}`);
    return 0;
  }
}
