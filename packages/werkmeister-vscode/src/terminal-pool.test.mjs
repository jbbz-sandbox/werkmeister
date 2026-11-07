import assert from "node:assert/strict";
import { test } from "node:test";
import { claim, forget, release, takeGone } from "../out/terminal-pool.js";

/** Stand-in terminals — the pool only ever compares them by identity. */
const term = (name) => ({ name });

test("a busy terminal is never reused", () => {
  const slots = [];
  const first = claim(slots, "/ws/a", () => term("up"));
  const second = claim(slots, "/ws/a", () => term("logs"));
  assert.notEqual(second, first);
  assert.equal(slots.length, 2);
});

test("an ended command frees its terminal for the next one", () => {
  const slots = [];
  const first = claim(slots, "/ws/a", () => term("up"));
  release(slots, first);
  assert.equal(
    claim(slots, "/ws/a", () => term("logs")),
    first,
  );
  assert.equal(slots.length, 1);
});

test("an idle terminal from another workspace is not reused", () => {
  const slots = [];
  const a = claim(slots, "/ws/a", () => term("up"));
  release(slots, a);
  assert.notEqual(
    claim(slots, "/ws/b", () => term("up")),
    a,
  );
});

test("a closed terminal is dropped rather than reused", () => {
  const slots = [];
  const first = claim(slots, "/ws/a", () => term("up"));
  release(slots, first);
  forget(slots, first);
  assert.notEqual(
    claim(slots, "/ws/a", () => term("logs")),
    first,
  );
  assert.equal(slots.length, 1);
});

test("release and forget ignore a terminal the pool never handed out", () => {
  const slots = [];
  const mine = claim(slots, "/ws/a", () => term("up"));
  release(slots, term("someone else's"));
  forget(slots, term("someone else's"));
  assert.equal(slots.length, 1);
  assert.notEqual(
    claim(slots, "/ws/a", () => term("logs")),
    mine,
  );
});

test("SW-421: a gone workspace's terminals are taken, others and hand-opened ones stay", () => {
  const pooled = term("werkmeister a");
  const session = term("claude a");
  const other = term("werkmeister b");
  const slots = [
    { term: pooled, cwd: "/ws/a", busy: false },
    { term: session, cwd: "/ws/a", busy: true },
    { term: other, cwd: "/ws/b", busy: false },
  ];
  const handOpened = term("zsh in /ws/a"); // never in slots, so never taken
  const taken = takeGone(slots, (s) => s.cwd !== "/ws/a");
  assert.deepEqual(taken, [pooled, session]);
  assert.ok(!taken.includes(handOpened));
  assert.deepEqual(
    slots.map((s) => s.term),
    [other],
  );
  assert.deepEqual(
    takeGone(slots, () => true),
    [],
  );
});
