import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePlan } from "./release-plan.mjs";

test("no queued version PR: changesets/action runs as today", () => {
  const plan = releasePlan({ queuedPr: null });
  assert.equal(plan.runChangesets, true);
  assert.deepEqual(plan.notices, []);
});

test("SW-1266: version PR in the merge queue skips the version step, naming the PR", () => {
  const plan = releasePlan({ queuedPr: 1123 });
  assert.equal(plan.runChangesets, false);
  assert.equal(plan.notices.length, 1);
  assert.match(plan.notices[0], /#1123/);
});
