import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSummary, mergeTotals, renderMarkdown } from "./coverage-summary.mjs";

const istanbul = (covered, total) => {
  const m = { covered, total, pct: Math.round((covered / total) * 10000) / 100 };
  return { total: { lines: m, branches: m, functions: m, statements: m } };
};

test("the total sums counts instead of averaging percentages", () => {
  // 10/10 and 0/90: the average of 100 % and 0 % would be 50 %.
  assert.equal(mergeTotals([istanbul(10, 10), istanbul(0, 90)]).lines, 10);
  assert.equal(mergeTotals([]).lines, 100);
});

test("buildSummary reads each package's report, run.json and package.json, and stamps CI", () => {
  const root = mkdtempSync(join(tmpdir(), "cov-summary-"));
  const pkg = (dir, name, run) => {
    mkdirSync(join(root, dir, "coverage"), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
    writeFileSync(
      join(root, dir, "coverage", "coverage-summary.json"),
      JSON.stringify(istanbul(1, 4)),
    );
    if (run) writeFileSync(join(root, dir, "coverage", "run.json"), JSON.stringify(run));
  };
  pkg("apps/a", "a", { tests: 5, duration_ms: 2000 });
  pkg("packages/b", "b");
  mkdirSync(join(root, "packages", "no-report"));
  const s = buildSummary(root, {
    COVERAGE_COMMIT: "abc",
    GITHUB_RUN_ID: "9",
    GITHUB_EVENT_NAME: "merge_group",
  });
  assert.deepEqual(Object.keys(s.packages).sort(), ["a", "b"]);
  assert.deepEqual(s.packages.a, {
    version: "1.2.3",
    lines: 25,
    branches: 25,
    functions: 25,
    statements: 25,
    tests: 5,
    duration_ms: 2000,
  });
  assert.equal(s.packages.b.tests, null);
  assert.equal(s.commit, "abc");
  assert.deepEqual(s.ci, { event: "merge_group", run: "9" });
  assert.equal(buildSummary(root, { COVERAGE_COMMIT: "abc" }).ci, undefined);
});

const row = (lines) => ({
  version: "1",
  lines,
  branches: 50,
  functions: 50,
  statements: 50,
  tests: 3,
  duration_ms: 1500,
});
const summary = {
  commit: "c",
  packages: { core: row(60), mcp: row(40) },
  total: { lines: 55, branches: 50, functions: 50, statements: 50 },
};

test("renderMarkdown shows the change per metric, and new packages", () => {
  const base = {
    commit: "0123456789",
    packages: { core: row(59.5) },
    total: { lines: 55, branches: 51, functions: 50, statements: 50 },
  };
  const md = renderMarkdown(summary, base);
  assert.match(
    md,
    /\| core \| 60 \(\+0\.5\) \| 50 \(±0\) \| 50 \(±0\) \| 50 \(±0\) \| 3 \| 2 s \|/,
  );
  assert.match(md, /\| mcp \| 40 \(new\) \|/);
  assert.match(md, /\| \*\*Total\*\* \| 55 \(±0\) \| 50 \(-1\) \|/);
  assert.match(md, /against 01234567\./);
});

test("renderMarkdown: no comparison asked shows no change; an unreadable base says there is no baseline", () => {
  assert.doesNotMatch(renderMarkdown(summary, undefined), /\(|baseline/);
  assert.match(renderMarkdown(summary, null), /No baseline \(first run after SW-405\)/);
  assert.doesNotMatch(renderMarkdown(summary, null), /\(new\)/);
});
