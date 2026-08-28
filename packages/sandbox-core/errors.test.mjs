import assert from "node:assert/strict";
import test from "node:test";

import { SandboxError } from "./dist/errors.js";
import { WorkspaceError } from "./dist/sandbox.js";

test("SandboxError carries its code and message", () => {
  const e = new SandboxError("no slot free", "NOT_RUNNING");
  assert.equal(e.code, "NOT_RUNNING");
  assert.equal(e.message, "no slot free");
  assert.ok(e instanceof Error);
});

// The fold's whole risk: ~45 throw sites and 12 `instanceof WorkspaceError`
// catches in the dashboard, none of which this PR touches. They keep working
// only if the subclass stays a WorkspaceError *and* an Error.
test("WorkspaceError still satisfies its existing catch sites", () => {
  const e = new WorkspaceError("No such workspace: foo");
  assert.ok(e instanceof WorkspaceError);
  assert.ok(e instanceof Error);
  assert.equal(e.message, "No such workspace: foo");
});

// What main.ts's handler branches on to keep printing `Error: <msg>` for these
// rather than the reporter's `[err] <msg>`.
test("WorkspaceError folds in under the WORKSPACE code", () => {
  const e = new WorkspaceError("boom");
  assert.ok(e instanceof SandboxError);
  assert.equal(e.code, "WORKSPACE");
});
