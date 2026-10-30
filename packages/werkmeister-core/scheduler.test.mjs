// SW-181: admission counts memory and CPU, queues when full, and lets a
// person's `up` preempt autonomous features in rank order.

import assert from "node:assert/strict";
import { test } from "node:test";

import { admit, parseSize, pickSlot } from "./dist/scheduler.js";

const G = 2 ** 30;
const budget = { memory: 4 * G, cpus: 4, preempt: true };
const lease = (feature, memory, cpus, rank = "idle", busy = false) => ({
  feature,
  cost: { memory: memory * G, cpus },
  rank,
  busy,
});
const req = (feature, memory, cpus, byPerson = false) => ({
  feature,
  cost: { memory: memory * G, cpus },
  byPerson,
});

test("parseSize reads compose sizes and rejects junk", () => {
  assert.equal(parseSize("512M"), 512 * 2 ** 20);
  assert.equal(parseSize("2G"), 2 * G);
  assert.equal(parseSize("1.5g"), 1.5 * G);
  assert.equal(parseSize("2GB"), 2 * G);
  assert.equal(parseSize(1234), 1234);
  assert.throws(() => parseSize("lots"), /Not a size/);
});

test("room for both memory and CPU admits", () => {
  assert.deepEqual(admit(budget, [lease("a", 1, 1)], [], req("b", 2, 2)), { kind: "admit" });
});

test("memory fits but CPU does not: wait", () => {
  assert.deepEqual(admit(budget, [lease("a", 1, 3)], [], req("b", 1, 2)), {
    kind: "wait",
    position: 1,
  });
});

test("CPU fits but memory does not: wait", () => {
  assert.deepEqual(admit(budget, [lease("a", 3, 1)], [], req("b", 2, 1)), {
    kind: "wait",
    position: 1,
  });
});

test("an already-running feature is admitted however full the budget", () => {
  assert.deepEqual(admit(budget, [lease("a", 4, 4)], [], req("a", 4, 4)), { kind: "admit" });
});

test("someone ahead in the queue: wait with a position, even when it fits", () => {
  assert.deepEqual(admit(budget, [], ["x", "y"], req("b", 1, 1)), { kind: "wait", position: 3 });
  assert.deepEqual(admit(budget, [], ["x", "b"], req("b", 1, 1)), { kind: "wait", position: 2 });
  assert.deepEqual(admit(budget, [], ["b", "x"], req("b", 1, 1)), { kind: "admit" });
});

test("a person preempts idle before human-check before working; never a person or busy one", () => {
  const running = [
    lease("working", 1, 1, "working"),
    lease("check", 1, 1, "human-check"),
    lease("mine", 1, 1, "person"),
    lease("gating", 1, 1, "idle", true),
  ];
  // Full: 4G/4 used. Needs 2G: idle-but-busy is skipped, so check then working.
  assert.deepEqual(admit(budget, running, [], req("p", 2, 2, true)), {
    kind: "preempt",
    victims: ["check", "working"],
  });
  assert.deepEqual(
    admit(budget, [lease("idle", 1, 1, "idle"), ...running.slice(0, 3)], [], req("p", 1, 1, true)),
    { kind: "preempt", victims: ["idle"] },
  );
  // Not enough preemptible capacity even with every candidate stopped.
  assert.equal(admit(budget, running, [], req("p", 3, 3, true)).kind, "wait");
});

test("preempt: false makes a person wait too", () => {
  const off = { ...budget, preempt: false };
  assert.deepEqual(admit(off, [lease("a", 4, 4, "idle")], [], req("p", 1, 1, true)), {
    kind: "wait",
    position: 1,
  });
});

test("an autonomous request never preempts", () => {
  assert.equal(admit(budget, [lease("a", 4, 4, "idle")], [], req("b", 1, 1)).kind, "wait");
});

test("pickSlot keeps a held slot, honours a free preferred one, else the lowest free", () => {
  const held = new Map([
    [1, "a"],
    [3, "b"],
  ]);
  assert.equal(pickSlot("b", held, 4, 2), 3);
  assert.equal(pickSlot("c", held, 4, 4), 4);
  assert.equal(pickSlot("c", held, 4, 3), 2);
  assert.equal(pickSlot("c", held, 4, null), 2);
  assert.equal(pickSlot("c", new Map([[1, "a"]]), 1, null), null);
});
