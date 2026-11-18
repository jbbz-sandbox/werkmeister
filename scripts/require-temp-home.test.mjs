// SW-662: a test entry refuses a HOME that holds the real ~/.werkmeister, unless with-temp-home made it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const guard = join(import.meta.dirname, "require-temp-home.sh");
const run = (env) =>
  spawnSync("sh", [guard], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("refuses a HOME with ~/.werkmeister; passes a bare one or with-temp-home's own", () => {
  const real = mkdtempSync(join(tmpdir(), "real-home-"));
  mkdirSync(join(real, ".werkmeister"));
  const refused = run({ HOME: real });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /holds the real ~\/\.werkmeister.*with-temp-home/);
  assert.equal(run({ HOME: real, TMPDIR: "/elsewhere" }).status, 1);
  assert.equal(run({ HOME: real, TMPDIR: real }).status, 0, "with-temp-home's HOME");
  assert.equal(
    run({ HOME: mkdtempSync(join(tmpdir(), "ci-home-")) }).status,
    0,
    "CI: no ~/.werkmeister",
  );
});

test("each suite the werkmeister-core row runs checks it first", () => {
  const root = join(import.meta.dirname, "..");
  for (const pkg of ["apps/cli", "apps/werkmeister-mcp"]) {
    const { test: cmd } = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")).scripts;
    assert.match(cmd, /^sh \.\.\/\.\.\/scripts\/require-temp-home\.sh && /, pkg);
  }
  // test:no-match runs every file's top level and after() hooks outside run-tests.sh (SW-816).
  const core = JSON.parse(
    readFileSync(join(root, "packages/werkmeister-core/package.json"), "utf8"),
  ).scripts;
  assert.match(
    core["test:no-match"],
    /^sh \.\.\/\.\.\/scripts\/require-temp-home\.sh && .*WERKMEISTER_GH_BIN=/,
  );
  assert.match(
    readFileSync(join(root, "packages/werkmeister-core/run-tests.sh"), "utf8"),
    /^sh \.\.\/\.\.\/scripts\/require-temp-home\.sh$/m,
  );
});
