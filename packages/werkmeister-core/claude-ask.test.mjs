// The ask helpers' one seam between an Agent SDK result message and what callers
// see (SW-386): the structured answer, or a WorkspaceError naming the result subtype.

import assert from "node:assert/strict";
import { test } from "node:test";

const { fromResult } = await import("./dist/harness/claude/cli.js");

const result = (fields) => ({
  type: "result",
  is_error: false,
  num_turns: 1,
  errors: [],
  ...fields,
});

test("a success result yields its structured output", () => {
  assert.deepEqual(
    fromResult(result({ subtype: "success", structured_output: { result: "done" } })),
    { result: "done" },
  );
});

test("a success result without structured output is 'no text'", () => {
  assert.throws(() => fromResult(result({ subtype: "success", result: "prose only" })), {
    name: "WorkspaceError",
    message: "Claude returned no text.",
  });
});

test("a success result flagged is_error names the reason, not 'no text'", () => {
  assert.throws(
    () => fromResult(result({ subtype: "success", is_error: true, result: "Not logged in" })),
    { name: "WorkspaceError", message: "claude ended with an error:\nNot logged in" },
  );
});

for (const subtype of [
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]) {
  test(`${subtype} becomes a WorkspaceError naming it and the SDK's errors`, () => {
    assert.throws(() => fromResult(result({ subtype, is_error: true, errors: ["boom", "bang"] })), {
      name: "WorkspaceError",
      message: `claude ended with ${subtype}:\nboom\nbang`,
    });
  });
}
