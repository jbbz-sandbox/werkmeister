// The follow/tail pair is the whole behavioural difference between the CLI's
// unbounded tail and the MCP surface's bounded read, and it is unobservable
// through composeLogs itself without a live docker daemon -- hence the seam.
import { test } from "node:test";
import assert from "node:assert/strict";

import { composeLogsArgs } from "./dist/compose.js";

test("the CLI's tail follows and defaults to 100 lines", () => {
  assert.deepEqual(composeLogsArgs(null, true, 100), ["logs", "-f", "--tail", "100"]);
});

test("a bounded read drops -f so the child exits on its own", () => {
  assert.deepEqual(composeLogsArgs(null, false, 200), ["logs", "--tail", "200"]);
  // Without this the sandbox-logs tool hangs until the client disconnects and
  // the disconnect is the only result.
  assert.ok(!composeLogsArgs(null, false, 200).includes("-f"));
});

test("a service filter goes last, after the flags", () => {
  assert.deepEqual(composeLogsArgs("api", false, 50), ["logs", "--tail", "50", "api"]);
});
