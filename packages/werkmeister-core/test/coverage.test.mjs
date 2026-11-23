// SW-405: coverage reports → `coverage` ledger rows (under a temp HOME, each line checked against the
// schema) and the changed-file coverage that close-out writes to coverage.json.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { sandboxHome } from "../dist/config.js";
import {
  changedFileCoverage,
  coverageRows,
  findCoverageReports,
  recordGateCoverage,
  writeCoverageSnapshot,
} from "../dist/coverage.js";
import { metricsPath, recordEvent } from "../dist/metrics.js";
import { withSandboxHome } from "./fixtures.mjs";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js").default;
const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../docs/superpowers/specs/2026-11-15-metrics-events.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({
  formats: { "date-time": (s) => !Number.isNaN(Date.parse(s)), uri: (s) => URL.canParse(s) },
}).compile(schema);

const counts = (covered, total) => {
  const c = { total, covered, skipped: 0, pct: Math.round((covered / total) * 10000) / 100 };
  return { lines: c, branches: c, functions: c, statements: c };
};

/** A package with a coverage report whose per-file keys are container paths, as c8 writes them. */
function pkg(root, rel, name, files, run) {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.9.1" }));
  const summary = { total: counts(3, 4) };
  for (const [f, [c, t]] of Object.entries(files)) summary[`/app/${rel}/${f}`] = counts(c, t);
  fs.writeFileSync(path.join(dir, "coverage", "coverage-summary.json"), JSON.stringify(summary));
  if (run) fs.writeFileSync(path.join(dir, "coverage", "run.json"), JSON.stringify(run));
  return dir;
}

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coverage-")));

test("findCoverageReports: the repo root and two levels down, never node_modules or deeper", () => {
  const root = tmp();
  try {
    pkg(root, "packages/core", "werkmeister-core", {}, { tests: 7, duration_ms: 900 });
    pkg(root, "apps/cli", "werkmeister", {});
    pkg(root, ".", "root", {});
    pkg(root, "node_modules/dep", "dep", {});
    pkg(root, "a/b/c", "too-deep", {});
    fs.mkdirSync(path.join(root, "apps", "broken", "coverage"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", "broken", "coverage", "coverage-summary.json"), "{");
    const found = findCoverageReports(root);
    assert.deepEqual(found.map((r) => r.pkg.name).sort(), [
      "root",
      "werkmeister",
      "werkmeister-core",
    ]);
    const core = found.find((r) => r.pkg.name === "werkmeister-core").pkg;
    assert.deepEqual(core, {
      name: "werkmeister-core",
      version: "0.9.1",
      lines: 75,
      branches: 75,
      functions: 75,
      statements: 75,
      tests: 7,
      duration_ms: 900,
    });
    assert.equal(found.find((r) => r.pkg.name === "werkmeister").pkg.tests, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coverage rows land under the temp HOME and validate; CI rows carry no workspace", async () => {
  await withSandboxHome(async (home) => {
    const pkgs = [
      {
        name: "werkmeister-core",
        version: "0.9.1",
        lines: 54.8,
        branches: 52.82,
        functions: 34.15,
        statements: 54.8,
        tests: 1715,
        duration_ms: 121000,
      },
      {
        name: "werkmeister-dashboard",
        lines: 92.4,
        branches: 75,
        functions: 91.66,
        statements: 92.4,
        tests: null,
        duration_ms: 17000,
      },
    ];
    const ci = coverageRows(pkgs, { source: "ci-pr", commit: "d7b749c0aaaa", run: "45208589128" });
    const gate = coverageRows(pkgs.slice(0, 1), {
      source: "gate",
      commit: "abc",
      workspace: "ws",
      run: "g1",
    });
    assert.equal(ci[0].version, "0.9.1+d7b749c0");
    assert.equal("version" in ci[1], false);
    assert.equal("tests" in ci[1], false, "an unknown count is left out");
    assert.equal("workspace" in ci[0], false);
    assert.equal(gate[0].workspace, "ws");
    for (const e of [...ci, ...gate]) assert.ok(recordEvent(e, "2026-11-24T10:00:00.000Z"));
    const file = metricsPath("2026-11-24T10:00:00.000Z");
    assert.ok(file.startsWith(home), "the log stays under the temp HOME");
    assert.ok(file.startsWith(sandboxHome()));
    const lines = fs
      .readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    for (const l of lines) assert.ok(validate(l), JSON.stringify(validate.errors));
  });
});

test("changedFileCoverage matches container paths by suffix and lists unmeasured source", () => {
  const root = tmp();
  try {
    pkg(root, "packages/core", "werkmeister-core", {
      "src/metrics.ts": [9, 10],
      "src/other.ts": [0, 5],
    });
    const c = changedFileCoverage(findCoverageReports(root), [
      "packages/core/src/metrics.ts",
      "packages/core/src/new.ts",
      "packages/core/test/new.test.mjs",
      "docs/coverage.md",
    ]);
    assert.deepEqual(c.files, [
      {
        path: "packages/core/src/metrics.ts",
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    ]);
    assert.deepEqual(c.notMeasured, ["packages/core/src/new.ts"]);
    assert.deepEqual(c.sum.lines, { covered: 9, total: 10 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const git = (cwd, ...a) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A workspace with one code worktree: main at origin/main, then one commit changing src/a.ts. */
function workspace() {
  const ws = tmp();
  const wt = path.join(ws, "app");
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.email", "t@t");
  git(wt, "config", "user.name", "t");
  fs.writeFileSync(path.join(wt, "src", "b.ts"), "b\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "base");
  git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
  for (const f of ["a.ts", "c.ts"]) fs.writeFileSync(path.join(wt, "src", f), `${f}\n`);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "change");
  return { ws, wt };
}

test("writeCoverageSnapshot: only the diff's files, from a report newer than HEAD; a retry keeps the first", () => {
  const { ws, wt } = workspace();
  try {
    const stale = path.join(wt, "coverage", "coverage-summary.json");
    pkg(wt, ".", "app", { "src/a.ts": [1, 4], "src/b.ts": [4, 4] });
    const old = Date.now() / 1000 - 86400 * 2;
    fs.utimesSync(stale, old, old);
    assert.equal(
      writeCoverageSnapshot(ws, [{ dir: "app", base: "main" }]),
      null,
      "a stale report writes nothing",
    );
    assert.equal(fs.existsSync(path.join(ws, "coverage.json")), false);

    fs.utimesSync(stale, new Date(), new Date());
    const line = writeCoverageSnapshot(ws, [
      { dir: "app", base: "main" },
      { dir: "app", base: "main" },
    ]);
    assert.match(line, /^Coverage of changed files: 25 % of lines/);
    const snap = JSON.parse(fs.readFileSync(path.join(ws, "coverage.json"), "utf8"));
    assert.equal(snap.schema, 1);
    assert.equal(snap.repos.app.commit, git(wt, "rev-parse", "HEAD"));
    assert.deepEqual(
      snap.repos.app.files.map((f) => f.path),
      ["src/a.ts"],
      "b.ts is unchanged",
    );
    assert.deepEqual(snap.repos.app.notMeasured, ["src/c.ts"]);
    assert.equal(snap.total.lines, 25);

    pkg(wt, ".", "app", { "src/a.ts": [4, 4] });
    assert.equal(
      writeCoverageSnapshot(ws, [{ dir: "app", base: "main" }]),
      "Coverage: see coverage.json",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ws, "coverage.json"), "utf8")).total.lines,
      25,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("recordGateCoverage logs only the reports written since the gate started", async () => {
  await withSandboxHome(async () => {
    const { ws, wt } = workspace();
    try {
      const started = Date.now();
      const stale = pkg(wt, "packages/old", "old", {});
      const before = (started - 60_000) / 1000;
      fs.utimesSync(path.join(stale, "coverage", "coverage-summary.json"), before, before);
      pkg(wt, "packages/new", "new", {}, { tests: 2, duration_ms: 10 });
      assert.equal(recordGateCoverage(wt, "ws", "g1", started), 1);
      const lines = fs
        .readFileSync(metricsPath(new Date().toISOString()), "utf8")
        .trimEnd()
        .split("\n");
      assert.equal(lines.length, 1);
      const e = JSON.parse(lines[0]);
      assert.ok(validate(e), JSON.stringify(validate.errors));
      assert.equal(e.source, "gate");
      assert.equal(e.package, "new");
      assert.equal(e.workspace, "ws");
      assert.equal(e.commit, git(wt, "rev-parse", "HEAD"));
      assert.equal(
        recordGateCoverage(path.join(ws, "missing"), "ws", "g2", started),
        0,
        "never throws",
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

test("coverageRows drops a row whose values don't fit the schema: a fork PR writes its own artifact", () => {
  const ok = { name: "p", version: "1.0.0", lines: 1, branches: 2, functions: 3, statements: 4 };
  const rows = coverageRows(
    [
      ok,
      { ...ok, lines: "x" },
      { ...ok, branches: 101 },
      { ...ok, name: { evil: 1 } },
      { ...ok, name: "q", version: { v: 1 }, tests: -1, duration_ms: 1.5 },
    ],
    { source: "ci-pr", commit: "abcdef12", run: "9" },
  );
  assert.deepEqual(
    rows.map((r) => [r.package, r.version, r.tests, r.duration_ms]),
    [
      ["p", "1.0.0+abcdef12", undefined, undefined],
      ["q", undefined, undefined, undefined],
    ],
  );
  for (const r of rows) assert.ok(validate({ v: 1, at: "2026-11-24T10:00:00Z", ...r }));
});
