// SW-1235: a scheduler op went unanswered for 120 s and the daemon's log had no line saying which or when.

import assert from "node:assert/strict";
import { test } from "node:test";

const { SLOW_OP_MS, timedOp } = await import("./dist/daemon_tools.js");

/** A clock that moves *step* ms between its two reads. */
const clock = (step) => {
  let t = Date.parse("2026-11-24T18:00:00.000Z");
  return () => {
    const now = t;
    t += step;
    return now;
  };
};

test("a scheduler op over SLOW_OP_MS is logged with its start time, name and length; a fast one is not", async () => {
  const lines = [];
  const log = (m) => lines.push(m);
  assert.equal(await timedOp("lease sw-1145", () => 7, log, clock(SLOW_OP_MS + 95_000)), 7);
  assert.deepEqual(lines, ["2026-11-24T18:00:00.000Z scheduler lease sw-1145 took 125 s"]);
  await timedOp("queue", async () => [], log, clock(SLOW_OP_MS));
  assert.equal(lines.length, 1, "at the limit itself, no line");
});

test("an op still running at SLOW_OP_MS is logged then, before it ends: a hung op never reaches its end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines = [];
  let finish;
  const op = timedOp(
    "lease sw-1145",
    () => new Promise((r) => (finish = r)),
    (m) => lines.push(m),
    clock(SLOW_OP_MS + 95_000),
  );
  t.mock.timers.tick(SLOW_OP_MS - 1);
  assert.deepEqual(lines, []);
  t.mock.timers.tick(1);
  assert.deepEqual(lines, [
    "2026-11-24T18:00:00.000Z scheduler lease sw-1145 still running after 30 s",
  ]);
  finish("ok");
  assert.equal(await op, "ok");
  assert.equal(lines[1], "2026-11-24T18:00:00.000Z scheduler lease sw-1145 took 125 s");
});

test("a slow op that throws is logged too, and its error still reaches the caller", async () => {
  const lines = [];
  await assert.rejects(
    timedOp(
      "admit a",
      () => {
        throw new Error("lock timeout");
      },
      (m) => lines.push(m),
      clock(SLOW_OP_MS + 1_000),
    ),
    /lock timeout/,
  );
  assert.match(lines[0], /scheduler admit a took 31 s$/);
});
