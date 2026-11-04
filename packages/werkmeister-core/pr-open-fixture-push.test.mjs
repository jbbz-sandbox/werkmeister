// SW-381: under WERKMEISTER_FIXTURE, `pr open` must not push to a real remote. It pushes to a
// local origin (the fixture's bare repo), skips any other, and is unchanged outside fixtures.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { defaultDeps, openPrs } from "./dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** The gate fixture, inited, with every git push recorded (and answered *pushCode*) instead of run. */
async function withGateFixture(fn, { origin, pushCode = 0 } = {}) {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      if (origin) git(fx.repo, "remote", "set-url", "origin", origin);
      const deps = defaultDeps();
      const real = deps.run;
      const pushes = [];
      deps.run = async (bin, args, cwd) => {
        if (bin === "git" && args.includes("push") && !args.includes("--delete")) {
          pushes.push(args);
          // The gate's dry run (SW-408) passes; the real push answers pushCode.
          const code = args.includes("--dry-run") ? 0 : pushCode;
          if (origin) return { code, stdout: "", stderr: code ? "denied" : "" };
        }
        return real(bin, args, cwd);
      };
      await fn(fx, deps, pushes);
    },
    { gate: true },
  );
}

test("a fixture with a local origin pushes there and opens through the fake gh", async () => {
  await withGateFixture(async (fx, deps, pushes) => {
    const { ok, lines } = await openPrs(fx.workspace, undefined, deps, { wait: false });
    assert.equal(ok, true, lines.join("\n"));
    assert.deepEqual(pushes, [
      ["-C", fx.repo, "push", "--dry-run", "--no-verify", "origin", "me/demo"],
      ["-C", fx.repo, "push", "-u", "origin", "me/demo"],
    ]);
    assert.equal(
      git(`${fx.root}/remotes/o/app.git`, "rev-parse", "me/demo"),
      git(fx.repo, "rev-parse", "HEAD"),
    );
    assert.ok(lines.includes("app: open https://github.com/o/app/pull/1"), lines.join("\n"));
    // The record (the opened PR file) is committed and pushed to the workspace's own origin.
    assert.equal(
      git(`${fx.root}/remotes/o/ws.git`, "log", "-1", "--format=%s", "me/demo"),
      "chore: record opened PR(s)",
    );
  });
});

test("a fixture whose origin is GitHub skips the push and the gate's dry run, and says so", async () => {
  await withGateFixture(
    async (fx, deps, pushes) => {
      const { lines } = await openPrs(fx.workspace, undefined, deps, { wait: false });
      assert.deepEqual(pushes, []);
      assert.ok(lines.includes("app: push skipped (fixture)"), lines.join("\n"));
      assert.match(lines.join("\n"), /✓ push: skipped \(fixture, origin is not local\)/);
    },
    { origin: "git@github.com:o/app.git" },
  );
});

test("outside a fixture the push to GitHub runs as before, and its failure ends that PR file", async () => {
  await withGateFixture(
    async (fx, deps, pushes) => {
      delete process.env.WERKMEISTER_FIXTURE;
      const { ok, lines } = await openPrs(fx.workspace, undefined, deps, { wait: false });
      assert.equal(ok, false);
      assert.deepEqual(pushes, [
        ["-C", fx.repo, "push", "--dry-run", "--no-verify", "origin", "me/demo"],
        ["-C", fx.repo, "push", "-u", "origin", "me/demo"],
      ]);
      assert.ok(lines.includes("app: push failed — denied"), lines.join("\n"));
    },
    { origin: "git@github.com:o/app.git", pushCode: 1 },
  );
});
