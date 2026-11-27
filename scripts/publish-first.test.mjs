import assert from "node:assert/strict";
import { test } from "node:test";
import { countVersionable, publishPlan } from "./publish-first.mjs";

// A push to main with one changeset pending and main's version on npm.
const today = { unpublished: [], pending: 1, versionable: 1 };

test("main published, changesets pending: nothing hidden, the action versions as today", () => {
  assert.deepEqual(publishPlan(today), { hide: false, restore: false, notices: [] });
});

test("no changesets pending: nothing hidden, the action publishes on its own", () => {
  const plan = publishPlan({ unpublished: ["werkmeister@1.2.3"], pending: 0, versionable: 0 });
  assert.equal(plan.hide, false);
});

test("unpublished version with changesets pending: hide, publish, restore, then version", () => {
  const plan = publishPlan({ ...today, unpublished: ["werkmeister@0.115.1"] });
  assert.equal(plan.hide, true);
  assert.equal(plan.restore, true);
  assert.match(plan.notices[0], /werkmeister@0\.115\.1/);
});

test("only ignored-package changesets on an unpublished version: hide for good, the action publishes (run 46043187201)", () => {
  const plan = publishPlan({ unpublished: ["werkmeister@0.115.1"], pending: 1, versionable: 0 });
  assert.equal(plan.hide, true);
  assert.equal(plan.restore, false);
});

test("only ignored-package changesets on a published version: hidden too, so no empty version PR", () => {
  const plan = publishPlan({ ...today, versionable: 0 });
  assert.equal(plan.hide, true);
  assert.equal(plan.restore, false);
});

test("unreadable .changeset (nulls): nothing hidden", () => {
  const plan = publishPlan({
    unpublished: ["werkmeister@1.0.0"],
    pending: null,
    versionable: null,
  });
  assert.equal(plan.hide, false);
});

const ignore = ["werkmeister-dashboard", "docs-site", "werkmeister-plugin"];

test("countVersionable: a changeset naming only ignored packages is not consumed", () => {
  const plugin = '---\n"werkmeister-plugin": patch\n---\n\nrank retry delay\n';
  assert.equal(countVersionable([plugin], ignore), 0);
});

test("countVersionable: an empty changeset is consumed, as `changeset version` deletes it", () => {
  assert.equal(countVersionable(["---\n---\n"], ignore), 1);
});

test("countVersionable: a released package counts, quoted or not; body text is not front matter", () => {
  const cli = '---\n"werkmeister": minor\nwerkmeister-plugin: patch\n---\n\nfoo: patch\n';
  assert.equal(countVersionable([cli], ignore), 1);
});
