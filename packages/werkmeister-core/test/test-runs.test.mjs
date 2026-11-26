import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readTurboTasks, testRunRows } from "../dist/test_runs.js";

const ctx = { workspace: "ws", run: "g1", row: "test lib" };
const task = (pkg, name, start, ms, extra = {}) => ({
  taskId: `${pkg}#${name}`,
  task: name,
  package: pkg,
  directory: `packages/${pkg}`,
  cache: { status: "MISS" },
  execution: { startTime: start, endTime: start + ms, exitCode: 0 },
  ...extra,
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-runs-"));
  fs.mkdirSync(path.join(dir, ".turbo", "runs"), { recursive: true });
  return dir;
}

test("readTurboTasks: fresh summaries only, an unreadable one skipped, every read one removed", () => {
  const dir = repo();
  try {
    const runs = path.join(dir, ".turbo", "runs");
    const old = path.join(runs, "old.json");
    fs.writeFileSync(old, JSON.stringify({ tasks: [task("a", "test", 1, 5)] }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    const since = Date.now() - 1000;
    fs.writeFileSync(
      path.join(runs, "new.json"),
      JSON.stringify({ tasks: [task("b", "test", 1, 5)] }),
    );
    fs.writeFileSync(path.join(runs, "bad.json"), "{");
    const got = readTurboTasks(dir, since);
    assert.deepEqual(
      got.map((t) => [t.package, t.task, t.startTime, t.endTime, t.cached]),
      [["b", "test", 1, 6, false]],
    );
    assert.deepEqual(
      fs.readdirSync(runs),
      ["old.json"],
      "the older summary is another run's, kept",
    );
    assert.deepEqual(readTurboTasks(path.join(dir, "missing"), 0), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("testRunRows: root tasks dropped, counts only from a run.json written since the row began", () => {
  const dir = repo();
  try {
    for (const p of ["a", "b"]) {
      fs.mkdirSync(path.join(dir, "packages", p, "coverage"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "packages", p, "coverage", "run.json"),
        JSON.stringify({ tests: 5, failures: 0, duration_ms: 10 }),
      );
    }
    const stale = path.join(dir, "packages", "b", "coverage", "run.json");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, past, past);
    const since = Date.now() - 1000;
    const base = (pkg, name) => {
      const t = task(pkg, name, 100, 50);
      return {
        package: t.package,
        task: t.task,
        directory: t.directory,
        startTime: 100,
        endTime: 150,
        exitCode: 0,
        cached: false,
      };
    };
    const rows = testRunRows(
      [base("a", "test"), base("b", "test"), { ...base("//", "test"), directory: "" }],
      dir,
      { ...ctx, run_id: "r" },
      since,
    );
    assert.deepEqual(
      rows.map((r) => [r.package, r.duration_ms, r.tests, r.failures, r.run_id]),
      [
        ["a", 50, 5, 0, "r"],
        ["b", 50, undefined, undefined, "r"],
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readTurboTasks never throws on a summary it can't remove, and keeps the others' tasks", () => {
  const dir = repo();
  try {
    const runs = path.join(dir, ".turbo", "runs");
    // A directory named like a summary: reading and removing it both fail, for root too.
    fs.mkdirSync(path.join(runs, "stuck.json"));
    fs.writeFileSync(
      path.join(runs, "ok.json"),
      JSON.stringify({ tasks: [task("b", "test", 1, 5)] }),
    );
    const got = readTurboTasks(dir, Date.now() - 1000);
    assert.deepEqual(
      got.map((t) => t.package),
      ["b"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
