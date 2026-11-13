// Split from fixture-workspace.test.mjs so the slow end-to-end runs share the cores: grouped issues and ship detection.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { startIssue } from "./dist/issue_status.js";
import { openPrs, refreshPrStatus } from "./dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("a grouped issue fixture shows a gh issue edit for the lead and each member (SW-509)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const edits = () =>
        fs
          .readFileSync(fx.ghLog, "utf8")
          .split("\n")
          .filter((l) => l.startsWith("issue edit "));
      const heads = (n) =>
        edits()
          .slice(n)
          .map((l) => l.split(" ")[2]);
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      await startIssue(fx.workspace);
      assert.deepEqual(heads(0), ["1", "2", "3"]);
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      assert.deepEqual(heads(3), ["1", "2", "3"]);
      await refreshPrStatus(fx.workspace);
      assert.match(fs.readFileSync(fx.ghLog, "utf8"), /^issue close 3 -R o\/app /m);
    },
    { gate: true, merged: true, issue: "o/app#1", workspace: { group: ["o/app#2", "o/app#3"] } },
  );
});

// SW-514: a ship: tag repo whose release check is changesets', as in werkmeister's own registry.
const TAG_SERVICES = `services:
  lib:
    type: cli
    repo: app
    path: packages/lib
    test: "true"
repos:
  app:
    services: [lib]
    path_mappings:
      packages/lib: lib
    ship: tag
    release_tag: "v*"
    release_check: pnpm changeset status --since=origin/main
`;

test("a merged skip_release PR with no changeset reads shipped (none) on the first pr status (SW-514)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace);
      assert.equal(open.ok, true, open.lines.join("\n"));
      const out = (await refreshPrStatus(fx.workspace)).lines.join("\n");
      assert.match(out, /app: shipped \(none\) https:\/\/github\.com\/o\/app\/pull\/1/);
      assert.doesNotMatch(out, /not shipped yet/);
    },
    { gate: true, merged: true, services: TAG_SERVICES, prFields: { skip_release: "tests only" } },
  );
});

test("a merged PR without skip_release still waits for a tag containing its merge (SW-514)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace);
      assert.equal(open.ok, true, open.lines.join("\n"));
      const out = (await refreshPrStatus(fx.workspace)).lines.join("\n");
      assert.match(out, /app: merged https:\/\/github\.com\/o\/app\/pull\/1/);
      assert.match(out, /not shipped yet: no release tag contains 0000000; no tag matches v\* yet/);
    },
    { gate: true, merged: true, services: TAG_SERVICES },
  );
});
