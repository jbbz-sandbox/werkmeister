import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { countFailures, countTests } from "./coverage-run.mjs";

test("counts node's TAP and spec summaries, summed across runs", () => {
  const tap = "ok 1 - a\n1..1\n# tests 12\n# suites 0\n# pass 12\n";
  const spec = "✔ a (1ms)\nℹ tests 1703\nℹ suites 4\nℹ pass 1703\n";
  assert.equal(countTests(tap), 12);
  assert.equal(countTests(tap + spec), 1715);
});

test("counts vitest's summary, failures included, with or without colour", () => {
  assert.equal(
    countTests(" Test Files  3 passed (3)\n      Tests  2 failed | 40 passed (42)\n"),
    42,
  );
  assert.equal(
    countTests(
      "      \x1b[2mTests\x1b[22m  \x1b[1m\x1b[32m7 passed\x1b[39m\x1b[22m\x1b[90m (7)\x1b[39m\n",
    ),
    7,
  );
});

test("null when no summary matched, and a logged line alone isn't a summary", () => {
  assert.equal(countTests("smoke ok\n"), null);
  assert.equal(countTests("# tests 3\nsomething else\n"), null);
});

test("passes the test command's exit code through and still writes run.json", () => {
  const cwd = mkdtempSync(join(tmpdir(), "coverage-run-"));
  try {
    const script = fileURLToPath(new URL("./coverage-run.mjs", import.meta.url));
    const r = spawnSync(
      process.execPath,
      [script, "--no-c8", "--", process.execPath, "-e", "process.exit(3)"],
      {
        cwd,
      },
    );
    assert.equal(r.status, 3);
    const run = JSON.parse(readFileSync(join(cwd, "coverage", "run.json"), "utf8"));
    assert.equal(run.tests, null);
    assert.equal(run.failures, null);
    assert.ok(Number.isInteger(run.duration_ms));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("counts failures in node's TAP and spec summaries and vitest's, 0 on a green run (SW-1101)", () => {
  const tap = "# tests 12\n# suites 0\n# pass 10\n# fail 2\n# cancelled 0\n# skipped 0\n";
  const spec = "ℹ tests 3\nℹ suites 1\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\n";
  assert.equal(countFailures(tap), 2);
  assert.equal(countFailures(tap + spec), 2);
  assert.equal(countFailures("      Tests  2 failed | 40 passed (42)\n"), 2);
  assert.equal(
    countFailures(
      "      \x1b[2mTests\x1b[22m  \x1b[1m\x1b[32m7 passed\x1b[39m\x1b[22m\x1b[90m (7)\x1b[39m\n",
    ),
    0,
  );
  assert.equal(countFailures("smoke ok\n# fail 3\nother\n"), null);
});
