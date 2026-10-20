// The follow/tail pair is the whole behavioural difference between the CLI's
// unbounded tail and the MCP surface's bounded read, and it is unobservable
// through composeLogs itself without a live docker daemon -- hence the seam.

import assert from "node:assert/strict";
import { test } from "node:test";

import { composeLogsArgs } from "./dist/compose.js";

test("the CLI's tail follows and defaults to 100 lines", () => {
  assert.deepEqual(composeLogsArgs(null, true, 100), [
    "--profile",
    "*",
    "logs",
    "-f",
    "--tail",
    "100",
  ]);
});

test("a bounded read drops -f so the child exits on its own", () => {
  assert.deepEqual(composeLogsArgs(null, false, 200), ["--profile", "*", "logs", "--tail", "200"]);
  // Without this the logs tool hangs until the client disconnects and
  // the disconnect is the only result.
  assert.ok(!composeLogsArgs(null, false, 200).includes("-f"));
});

test("a service filter goes last, after the flags", () => {
  assert.deepEqual(composeLogsArgs("api", false, 50), [
    "--profile",
    "*",
    "logs",
    "--tail",
    "50",
    "api",
  ]);
});
