// Split from fixture-workspace.test.mjs so the slow end-to-end runs share the cores: gate rows, merge and issue flows.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { closeOut, gatePrs, openPrs, refreshPrStatus } from "./dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("with execRuns the gate's lint and test rows pass or fail on the registry's commands (SW-473)", async () => {
  const gate = (lint, libTest) =>
    withFixtureWorkspace(
      async (fx) => {
        await withReporter(collectingReporter(), () =>
          initWorkspace({}, fx.workspace, { build: false }),
        );
        return gatePrs(fx.workspace);
      },
      {
        gate: true,
        execRuns: true,
        services: `services:\n  lib: { type: cli, repo: app, path: packages/lib, test: "${libTest}" }\nrepos:\n  app: { services: [lib], lint: "${lint}", path_mappings: { packages/lib: lib } }\n`,
      },
    );
  const pass = await gate("true", "test -f packages/lib/index.js");
  assert.equal(pass.ok, true, pass.lines.join("\n"));
  const badLint = await gate("false", "true");
  assert.equal(badLint.ok, false);
  assert.match(badLint.lines.join("\n"), /✗ lint: false → exit 1/);
  const badTest = await gate("true", "false");
  assert.equal(badTest.ok, false);
  assert.match(badTest.lines.join("\n"), /✗ test lib: false → exit 1/);
});

test("a grouped icm gate fixture passes pr gate with no hand edits (SW-464)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      assert.match(
        fs.readFileSync(path.join(fx.workspace, ".werkmeister", "workspace.yml"), "utf8"),
        /group:\n\s+- SW-2/,
      );
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const { ok, lines } = await gatePrs(fx.workspace);
      const out = lines.join("\n");
      assert.equal(ok, true, out);
      assert.match(out, /✓ merge:/);
      assert.match(out, /✓ exercise: stages\/04_propose\/output\/exercise\.md/);
    },
    { gate: true, workspace: { group: ["SW-2"], context_strategy: "icm" } },
  );
});

test("with merged the fake gh reports the PR merged, so a run reaches workspace close (SW-482)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace);
      assert.equal(open.ok, true, open.lines.join("\n"));
      const status = await refreshPrStatus(fx.workspace);
      assert.match(status.lines.join("\n"), /app: shipped https:\/\/github\.com\/o\/app\/pull\/1/);
      await withReporter(collectingReporter(), () =>
        closeOut("demo", { skipPostmortem: "fixture" }),
      );
      assert.equal(fs.existsSync(fx.workspace), false, "the workspace is removed");
      assert.match(fs.readFileSync(fx.dockerLog, "utf8"), /^compose .* down /m);
    },
    { gate: true, merged: true },
  );
});

// SW-509: o/<repo>#N refs resolve to the fixture's GitHub project, so the fake gh logs every move.
test("with issue, pr open, pr status and workspace close move it through the fake gh (SW-509)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      await refreshPrStatus(fx.workspace);
      const closed = collectingReporter();
      await withReporter(closed, () => closeOut("demo", { skipPostmortem: "fixture" }));
      const gh = fs.readFileSync(fx.ghLog, "utf8");
      assert.match(gh, /^issue edit 1 -R o\/app --add-label status: in review$/m);
      assert.match(gh, /^issue close 1 -R o\/app --reason completed$/m);
      assert.match(gh, /^issue comment 1 -R o\/app --body /m);
      assert.doesNotMatch(closed.text(), /no Jira REST credentials/);
    },
    { gate: true, merged: true, issue: "o/app#1" },
  );
});
