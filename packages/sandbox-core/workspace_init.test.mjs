// `workspace.ts` and `init_workspace.ts` ended their fatal paths on
// `error(msg); process.exit(1)`. A library cannot exit, so those became
// `fail()`: emit the same `[err]` line, then throw. Two things have to hold or
// the CLI's output changes — the line still goes out exactly once, and the
// throw is the silent kind the argv adapters turn into exit 1 without
// reprinting (note 086 row 5).
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { WorkspaceInitError, provisionWorkspace } from "./dist/workspace_init.js";

/** Run `fn`, returning its rejection and everything it printed. */
async function abort(fn) {
  const collector = collectingReporter();
  const err = await withReporter(collector, () => fn().then(() => null, (e) => e));
  return { err, text: collector.text() };
}

test("a missing feature aborts before touching the filesystem", async () => {
  const { err, text } = await abort(() => provisionWorkspace({}));
  assert.ok(err instanceof WorkspaceInitError, `got ${err}`);
  assert.match(text, /^\x1b\[31m\[err\] {2}A feature name is required/);
  // Exactly one line: the adapters exit on this without printing it again.
  assert.equal(text.trimEnd().split("\n").length, 1);
  assert.match(err.message, /^A feature name is required/);
});

test("a feature that is not a slug aborts with the name it rejected", async () => {
  const { err, text } = await abort(() => provisionWorkspace({ feature: "Not A Slug" }));
  assert.ok(err instanceof WorkspaceInitError, `got ${err}`);
  assert.match(text, /Workspace name 'not a slug' is not a valid slug/);
  assert.equal(text.trimEnd().split("\n").length, 1);
});
