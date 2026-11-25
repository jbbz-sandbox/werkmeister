// SW-1147: a capacity wait that only a person can end (its holder waits on a person, with a run in flight
// so neither preemption nor the reaper takes it) gives up at once instead of polling out 30 min.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { blockedOnPerson } from "../dist/scheduler.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const holder = {
  feature: "holder",
  workspace: "holder",
  startedAt: "2026-11-13T00:00:00Z",
  memory: 0,
  nanoCpus: 6e9,
  execs: 1,
};

/** A working session in *ws*, autonomous, so its lease ranks `working`. */
function working(ws) {
  const at = new Date().toISOString();
  fs.mkdirSync(path.join(ws, ".werkmeister", "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "sessions", "s1.json"),
    JSON.stringify({ status: "busy", at, last: at }),
  );
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "autonomous: true\n");
}

/** Start `api` for the queued `mine` (1 CPU) against the 6-CPU budget the holder fills; count the polls. */
async function startMine(waitMs) {
  const { admitServiceStart } = await import("../dist/lifecycle.js");
  const { readLeases } = await import("../dist/scheduler_state.js");
  let slept = 0;
  const err = await admitServiceStart("mine", readLeases().mine.workspace, "api", {
    sleep: async () => {
      slept++;
    },
    waitMs,
  }).catch((e) => e);
  return { err, slept };
}

const opts = (h) => ({
  containers: [h],
  queue: ["mine:0:api"],
  config: { budget: { cpus: 6 } },
});

test("a gate's wait whose only holder waits on a person, run in flight, fails NO_CAPACITY at once naming it (SW-1147)", async () => {
  const { GATE_CAPACITY_WAIT_MS } = await import("../dist/lifecycle.js");
  const { readQueue } = await import("../dist/scheduler_state.js");
  await withFixtureWorkspace(
    async () => {
      const { err, slept } = await startMine(GATE_CAPACITY_WAIT_MS);
      assert.equal(err?.code, "NO_CAPACITY", String(err));
      assert.equal(slept, 0, "it gave up without polling");
      assert.match(err.message, /without waiting: only a person can free the room/);
      assert.match(err.message, /holder \(6 CPUs, 0\.0 GiB, waiting on a person, run in flight\)/);
      assert.match(
        err.message,
        /holder: answer its question, or stop it from the pane \(werkmeister feature stop holder\)/,
      );
      assert.match(err.message, /once one of these is answered or stopped/);
      assert.doesNotMatch(err.message, /nothing to ask a person/);
      assert.deepEqual(readQueue(), [], "it left the queue, as a timed-out wait does");
    },
    opts({ ...holder, asking: true }),
  );
});

test("a wait whose holder is working still polls out its wait (SW-1147)", async () => {
  await withFixtureWorkspace(async (fx) => {
    working(path.join(fx.root, "ws", "holder"));
    const { err, slept } = await startMine(3 * 15_000);
    assert.equal(err?.code, "NO_CAPACITY", String(err));
    assert.equal(slept, 3);
    assert.doesNotMatch(err.message, /answer its question/);
    assert.match(err.message, /nothing to ask a person/);
  }, opts(holder));
});

test("a queued plain up's note names a holder only a person can free, and the step (SW-1147)", async () => {
  const { capacityWait } = await import("../dist/lifecycle.js");
  await withFixtureWorkspace(
    async () => {
      const note = await capacityWait("mine", 1, true, { cpus: 1, memory: 0 });
      assert.match(note, /holder: answer its question, or stop it from the pane/);
      assert.match(note, /It starts by itself when room frees/);
    },
    opts({ ...holder, asking: true }),
  );
});

// The predicate, one test per condition.
const budget = { cpus: 6, memory: 8 * 2 ** 30, preempt: true };
const lease = (feature, cpus, rank, busy) => ({
  feature,
  cost: { cpus, memory: 0 },
  rank,
  busy,
});
const need = { cpus: 1, memory: 0 };

test("blockedOnPerson: a busy holder waiting on a person that alone covers the shortfall is returned", () => {
  const h = lease("h", 6, "human-check", true);
  assert.deepEqual(blockedOnPerson(budget, [h], "mine", need), [h]);
});

test("blockedOnPerson: a holder waiting on a person with no run in flight is not (preemption or the reaper takes it)", () => {
  assert.deepEqual(
    blockedOnPerson(budget, [lease("h", 6, "human-check", false)], "mine", need),
    [],
  );
});

test("blockedOnPerson: a working or idle holder is not", () => {
  for (const rank of ["working", "idle", "person"])
    assert.deepEqual(blockedOnPerson(budget, [lease("h", 6, rank, true)], "mine", need), [], rank);
});

test("blockedOnPerson: none when another holder's room could still cover the start", () => {
  const running = [lease("h", 3, "human-check", true), lease("w", 3, "working", false)];
  assert.deepEqual(blockedOnPerson(budget, running, "mine", need), []);
});

test("blockedOnPerson: the start's own lease and reserved starts never free room", () => {
  const h = lease("h", 3, "human-check", true);
  const own = lease("mine", 2, "working", true);
  const reserved = [lease("r", 1, "person", true)];
  assert.deepEqual(blockedOnPerson(budget, [h, own], "mine", need, reserved), [h]);
  assert.deepEqual(blockedOnPerson(budget, [h, own], "mine", need), [], "fits once r is gone");
  assert.deepEqual(
    blockedOnPerson(budget, [own], "mine", { cpus: 5, memory: 0 }),
    [],
    "nobody to name",
  );
});

test("blockedOnPerson: memory over the budget counts as CPUs do", () => {
  const h = { ...lease("h", 0, "human-check", true), cost: { cpus: 0, memory: 8 * 2 ** 30 } };
  assert.deepEqual(blockedOnPerson(budget, [h], "mine", { cpus: 0, memory: 1 }), [h]);
});
