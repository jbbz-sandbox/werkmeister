// SW-977: reduceCodexSession's active spans, the Codex copy of the Claude lines that
// harness-claude-usage.smoke.mjs covers: gaps under 5 min join a span, a longer one starts another.

import assert from "node:assert/strict";
import { test } from "node:test";
import { reduceCodexSession } from "../dist/harness/codex/usage.js";

const at = (hhmm) =>
  `${JSON.stringify({
    type: "event_msg",
    timestamp: `2026-11-20T${hhmm}:00.000Z`,
    payload: { type: "agent_message", message: "ok" },
  })}\n`;
const ms = (hhmm) => Date.parse(`2026-11-20T${hhmm}:00.000Z`);

test("reduceCodexSession: lines 2 min apart and one 10 min later give two spans", () => {
  assert.deepEqual(reduceCodexSession(at("10:00") + at("10:02") + at("10:12")).activeSpans, [
    [ms("10:00"), ms("10:02")],
    [ms("10:12"), ms("10:12")],
  ]);
});
