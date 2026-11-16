// SW-181: admission counts memory and CPU, queues when full, and lets a
// person's `up` preempt autonomous features in rank order.

import assert from "node:assert/strict";
import { test } from "node:test";

import { admit, parseSize, pickSlot, queueOrder, STARVE_MS } from "../dist/scheduler.js";

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
const MIN = 60_000;
/** A queued request (SW-675): *waited* in minutes; *gate* a services start beside running containers. */
const w = (feature, waited = 0, gate = false) => ({ feature, waitedMs: waited * MIN, gate });
const q = (...names) => names.map((n) => w(n));

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

// SW-540: a gate start prices only the service it adds, so the running feature must still fit it.
test("a service start for an already-running feature still has to fit", () => {
  const start = { ...req("a", 1, 1), services: ["api"] };
  assert.deepEqual(admit(budget, [lease("a", 3, 4)], [], start), { kind: "wait", position: 1 });
  assert.deepEqual(admit(budget, [lease("a", 3, 3)], [], start), { kind: "admit" });
});

// SW-629: no preemption frees more than the whole budget, so such a start must not queue forever.
test("a cost larger than the whole budget never fits, whoever asks and whatever runs", () => {
  const over = { kind: "never-fits", cost: { memory: 1 * G, cpus: 6 } };
  assert.deepEqual(admit(budget, [], [], req("b", 1, 6)), over);
  assert.deepEqual(admit(budget, [lease("a", 1, 1)], q("x"), req("b", 1, 6, true)), over);
  assert.deepEqual(admit(budget, [], [], { ...req("b", 1, 6), services: ["api"] }), over);
  assert.deepEqual(admit(budget, [], [], req("b", 5, 1)), {
    kind: "never-fits",
    cost: { memory: 5 * G, cpus: 1 },
  });
  // Exactly the budget still fits an empty engine.
  assert.deepEqual(admit(budget, [], [], req("b", 4, 4)), { kind: "admit" });
});

// SW-675: strict FIFO let a head that doesn't fit block every smaller start behind it.
test("backfill: a start that fits passes the head until the head has waited 5 min", () => {
  assert.deepEqual(admit(budget, [], q("x", "y"), req("b", 1, 1)), { kind: "admit" });
  assert.deepEqual(admit(budget, [], [w("x", 4), w("b")], req("b", 1, 1)), { kind: "admit" });
  assert.deepEqual(admit(budget, [], [w("x", 5), w("y")], req("b", 1, 1)), {
    kind: "wait",
    position: 3,
  });
  assert.deepEqual(admit(budget, [], [w("x", 5), w("b")], req("b", 1, 1)), {
    kind: "wait",
    position: 2,
  });
  assert.deepEqual(admit(budget, [], [w("b", 30), w("x")], req("b", 1, 1)), { kind: "admit" });
  // A person's start passes even a starved head.
  assert.deepEqual(admit(budget, [], [w("x", 30)], req("p", 1, 1, true)), { kind: "admit" });
});

// SW-729: only a grant starts a whole-feature head, and room freed with no release (a timed-out gate's
// stop, Docker restarted) runs none, so a starved head that fits held every start behind it forever.
test("backfill: a starved whole-feature head that fits now does not hold a start behind it", () => {
  const head = (cpus) => ({ ...w("sdk-docs-keys", 239), cost: { memory: 1 * G, cpus } });
  const core = { ...req("core-test-changed", 1, 1), services: ["werkmeister-core"] };
  assert.deepEqual(admit(budget, [], [head(3)], core), { kind: "admit" });
  // It still holds while it doesn't fit: the room is its, once a release grants it.
  assert.deepEqual(admit(budget, [lease("a", 1, 2)], [head(3)], core), {
    kind: "wait",
    position: 2,
  });
  // Worst case, 1-CPU starts on 6 CPUs: each passes while the head still fits, so the 4th takes its
  // room and the head waits for that start's release to grant it.
  const six = { memory: 16 * G, cpus: 6, preempt: true };
  const running = [];
  for (let i = 0; i < 6; i++) {
    const start = { ...req(`s${i}`, 1, 1), services: ["cli"] };
    if (admit(six, running, [head(3)], start).kind === "admit") running.push(lease(`s${i}`, 1, 1));
  }
  assert.equal(running.length, 4);
});

// T1: the wave's shape. Core holds 3 of 6; a whole-feature up needing 5 heads the queue.
test("backfill: a 1-CPU service start passes a whole-feature head that cannot fit", () => {
  const six = { memory: 4 * G, cpus: 6, preempt: true };
  const running = [lease("never-fits", 0.75, 3, "human-check", true)];
  const cli = { ...req("daemon-scope", 1, 1), services: ["cli"] };
  assert.deepEqual(admit(six, running, [w("fixture-options", 2)], cli), { kind: "admit" });
  assert.deepEqual(admit(six, running, [w("fixture-options", 11)], cli), {
    kind: "wait",
    position: 2,
  });
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

// T3. SW-675: a plain-up head blocked preemption for everyone behind it, so the idle holder stayed.
test("a plain-up head preempts idle and human-check leases only after waiting 5 min", () => {
  const running = [
    lease("busy", 1, 1, "idle", true),
    lease("mine", 1, 1, "person"),
    lease("check", 2, 2, "human-check"),
  ];
  // Fresh: a grant's re-up of a victim must not evict another at once.
  assert.equal(admit(budget, [lease("a", 4, 4, "idle")], [], req("b", 1, 1)).kind, "wait");
  assert.equal(admit(budget, running, [w("b", 4)], req("b", 2, 2)).kind, "wait");
  assert.deepEqual(admit(budget, running, [w("b", 5)], req("b", 2, 2)), {
    kind: "preempt",
    victims: ["check"],
  });
  // Never a busy or person lease, and not when it is not the head.
  assert.equal(admit(budget, running, [w("b", 5)], req("b", 3, 3)).kind, "wait");
  assert.equal(admit(budget, running, [w("x", 1), w("b", 20)], req("b", 2, 2)).kind, "wait");
});

test("a service start never takes a working, person or busy lease, nor jumps the queue", () => {
  const start = (feature, queue = []) =>
    admit(budget, running, queue, { ...req(feature, 1, 1), services: ["api"] }).kind;
  const running = [
    lease("working", 2, 2, "working"),
    lease("mine", 1, 1, "person"),
    lease("gating", 1, 1, "human-check", true),
  ];
  assert.equal(start("s"), "wait");
  running.push(lease("parked", 0, 0, "human-check")); // frees nothing, so still wait
  assert.equal(start("s"), "wait");
  // A zero-cost lease is never a victim, even when it is the oldest idle one.
  assert.deepEqual(
    admit(budget, [lease("free", 0, 0), lease("a", 4, 4)], [], {
      ...req("s", 1, 1),
      services: ["api"],
    }),
    { kind: "preempt", victims: ["a"] },
  );
  // Room only by evicting an idle one, but someone else is ahead: wait for its turn.
  assert.equal(
    admit(budget, [lease("a", 4, 4, "idle")], q("x"), { ...req("s", 1, 1), services: ["api"] })
      .kind,
    "wait",
  );
  assert.deepEqual(
    admit(budget, [lease("a", 4, 4, "idle")], q("s"), { ...req("s", 1, 1), services: ["api"] }),
    {
      kind: "preempt",
      victims: ["a"],
    },
  );
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

test("a service start preempts human-check and idle holders when it cannot fit (SW-546)", () => {
  // Interactive runs parked on a question box hold 3 of 4 CPUs at 0% use; a gate's service start needs 3.
  const running = [
    lease("sw-541", 1, 1, "human-check"),
    lease("sw-521", 1, 1, "human-check"),
    lease("sw-526", 1, 1, "working"),
  ];
  const start = { ...req("sw-478", 3, 3), services: ["werkmeister-core"] };
  assert.deepEqual(admit(budget, running, [], start), {
    kind: "preempt",
    victims: ["sw-541", "sw-521"],
  });
});

// T2: the ticket's circular wait. never-fits holds core and its gate needs cli + docs-site; a
// whole-feature up that cannot fit is ahead of it in the queue.
test("a gate start goes ahead of plain ups, and backfill never passes a gate head", () => {
  const six = { memory: 4 * G, cpus: 6, preempt: true };
  const running = [lease("never-fits", 0.75, 3, "human-check", true)];
  const gate = { ...req("never-fits", 1.8, 2), services: ["cli", "docs-site"] };
  assert.deepEqual(admit(six, running, [w("fixture-options", 100), w("never-fits", 5)], gate), {
    kind: "admit",
  });
  assert.deepEqual(
    queueOrder([w("a"), w("g", 0, true), w("b")]).map((x) => x.feature),
    ["g", "a", "b"],
  );
  // A fresh gate head holds the room: a plain up that fits waits behind it.
  const full = [lease("a", 1, 3, "working"), lease("b", 1, 3, "working")];
  assert.deepEqual(admit(six, full.slice(0, 1), [w("g", 0, true)], req("c", 1, 1)), {
    kind: "wait",
    position: 2,
  });
});

// T13: two gates each hold core (3 + 3 of 6) and each needs one more CPU (the sw-631 case).
test("a gate that released its own containers is admitted for the whole set once the other releases", () => {
  const six = { memory: 4 * G, cpus: 6, preempt: true };
  const holdA = lease("a", 0.75, 3, "working", true);
  const holdB = lease("b", 0.75, 3, "working", true);
  const cli = (f) => ({ ...req(f, 1, 1), services: ["cli"] });
  // Holding: both wait, and neither can take the other's busy lease.
  assert.equal(admit(six, [holdA, holdB], q("b"), cli("a")).kind, "wait");
  // a released and asks for core + cli together; b still holds.
  const whole = (f) => ({ ...req(f, 1.75, 4), services: ["core", "cli"], gate: true });
  assert.equal(admit(six, [holdB], [w("a", 0, true)], whole("a")).kind, "wait");
  // b released too: a, first, fits; b waits for a to finish.
  const queue = [w("a", 1, true), w("b", 0, true)];
  assert.deepEqual(admit(six, [], queue, whole("a")), { kind: "admit" });
  const aUp = lease("a", 1.75, 4, "working", true);
  assert.equal(admit(six, [aUp], [w("b", 1, true)], whole("b")).kind, "wait");
  assert.deepEqual(admit(six, [], [w("b", 2, true)], whole("b")), { kind: "admit" });
});

// T4: SW-675 "Done when": six workspaces on a 6-CPU budget, each needing the 3-CPU core, all reach
// pr open with no question to a person: a start that waits 10 min exits 75 and the agent reruns it.
// One sits on a person's question for an hour holding core; the reaper takes it. A gate (core + cli +
// docs-site = 5 CPUs) runs alone, so gates wait for working cores: reruns, never a deadlock.
test("six workspaces on 6 CPUs all reach pr open with no person, only reruns", () => {
  const six = { memory: 4 * G, cpus: 6, preempt: true, idleStop: 10 };
  const CORE = { memory: 0.75 * G, cpus: 3 };
  const GATE = { memory: 1.8 * G, cpus: 2 };
  const SERVICE_WAIT_MIN = 10;
  const ws = ["a", "b", "c", "d", "e", "f"].map((name, i) => ({
    name,
    phase: "want-core", // want-core → work → want-gate → gate → done; ask: on a question
    holds: null, // Cost held now
    since: null, // minute the current wait began
    left: 0,
    asks: i === 1 ? 60 : 0, // b waits on a person for an hour after its core starts
    gateRelease: false,
  }));
  const queue = []; // names, first come first served
  const retries = { core: 0, gate: 0 };
  let end = 0;
  const running = () =>
    ws
      .filter((x) => x.holds)
      .map((x) => ({
        feature: x.name,
        cost: x.holds,
        rank: x.phase === "ask" ? "human-check" : "working",
        busy: x.phase === "gate" || x.phase === "want-gate",
      }));
  for (let t = 0; t < 600 && ws.some((x) => x.phase !== "done"); t++) {
    end = t;
    for (const x of ws) {
      if (x.phase === "work" || x.phase === "gate" || x.phase === "ask") {
        if (--x.left > 0) continue;
        if (x.phase === "ask") [x.phase, x.left] = ["work", 15];
        else if (x.phase === "work") x.phase = "want-gate";
        else [x.phase, x.holds] = ["done", null]; // pr open done; feature stop frees it all
      }
    }
    // The reaper: a holder parked on a person past idle_stop while others queue is stopped (§4).
    for (const x of ws)
      if (x.phase === "ask" && queue.length && 60 - x.left >= six.idleStop) {
        [x.phase, x.holds, x.since] = ["want-core", null, null];
        x.asks = 0;
      }
    const waiter = (x) => ({
      feature: x.name,
      waitedMs: (t - x.since) * MIN,
      gate: x.phase === "want-gate",
    });
    const wanting = ws.filter((x) => x.phase === "want-core" || x.phase === "want-gate");
    for (const x of wanting) {
      if (x.since === null) x.since = t;
      const gate = x.phase === "want-gate";
      // Release instead of hold (§2b): a waiting gate asks for core + its services together.
      const r = gate
        ? x.gateRelease
          ? {
              ...req(x.name, 0, 0),
              cost: { memory: CORE.memory + GATE.memory, cpus: 5 },
              services: ["core", "cli"],
              gate: true,
            }
          : { ...req(x.name, 0, 0), cost: GATE, services: ["cli"] }
        : { ...req(x.name, 0, 0), cost: CORE, services: ["core"] };
      const order = queueOrder(queue.map((n) => waiter(ws.find((y) => y.name === n))));
      const d = admit(six, running(), order, r);
      if (d.kind === "wait" && gate && !x.gateRelease) {
        x.gateRelease = true;
        x.holds = null;
        if (!queue.includes(x.name)) queue.push(x.name);
        continue;
      }
      if (d.kind === "wait") {
        if (!queue.includes(x.name)) queue.push(x.name);
        if (t - x.since < SERVICE_WAIT_MIN) continue;
        // A timeout exits 75 and the agent reruns the same command: back of its queue class, no person.
        queue.splice(queue.indexOf(x.name), 1);
        queue.push(x.name);
        x.since = t;
        retries[gate ? "gate" : "core"]++;
        continue;
      }
      if (d.kind === "preempt")
        for (const v of d.victims) {
          const y = ws.find((z) => z.name === v);
          [y.phase, y.holds, y.since] = ["want-core", null, null];
        }
      if (queue.includes(x.name)) queue.splice(queue.indexOf(x.name), 1);
      x.since = null;
      if (gate)
        [x.phase, x.left, x.holds] = ["gate", 12, { memory: CORE.memory + GATE.memory, cpus: 5 }];
      else if (x.asks) [x.phase, x.left, x.holds] = ["ask", x.asks, CORE];
      else [x.phase, x.left, x.holds] = ["work", 20, CORE];
    }
  }
  // Before SW-675 two gates holding core each waited on the other forever; here every one finishes.
  assert.ok(end < 600, `still running at ${end} min`);
  assert.ok(retries.gate + retries.core < 40, JSON.stringify(retries));
  assert.deepEqual(
    ws.map((x) => `${x.name}:${x.phase}`),
    ["a:done", "b:done", "c:done", "d:done", "e:done", "f:done"],
  );
  assert.equal(STARVE_MS, 5 * MIN);
});

// SW-699: the starved head waits on a busy lease whose own gate waits behind it. A (publish-core-npm)
// runs core with a gate and wants docs-site (1); B (daemon-conn-reset) runs docs-site (1) and wants
// core + install (5), head for 9 min. Neither may take the other's lease, so nothing ever starts.
test("a starved head does not hold the line against the busy feature it waits on (SW-699)", () => {
  const eight = { memory: 8 * G, cpus: 8, preempt: true };
  const a = lease("a", 1.1, 3, "person", true);
  const b = lease("b", 0.8, 1, "person");
  const queue = [w("b", 9, true), w("a", 4, true)];
  const aDocs = { ...req("a", 0.8, 1), services: ["docs-site"] };
  const bCore = { ...req("b", 1.6, 5), services: ["werkmeister-core", "werkmeister-install"] };
  const decisions = [admit(eight, [a, b], queue, aDocs), admit(eight, [a, b], queue, bCore)];
  assert.ok(
    decisions.some((d) => d.kind !== "wait"),
    `deadlock: ${JSON.stringify(decisions)}`,
  );
  // A's docs-site starts; B keeps its place, and gets the room once A's gate ends and A stops.
  assert.deepEqual(decisions, [{ kind: "admit" }, { kind: "wait", position: 1 }]);
  assert.deepEqual(admit(eight, [b], [w("b", 12, true)], bCore), { kind: "admit" });
});

test("only a busy feature's service start that fits passes a holding head (SW-699)", () => {
  const eight = { memory: 8 * G, cpus: 8, preempt: true };
  const other = lease("x", 1, 4, "person");
  const docs = (f, cpus = 1) => ({ ...req(f, 0.5, cpus), services: ["docs-site"] });
  // A gate head: a start beside running containers always queues ahead of a plain up anyway.
  const head = [w("h", 9, true)];
  // Busy, fits: passes the starved gate head.
  const busy = [other, lease("a", 1, 3, "person", true)];
  assert.deepEqual(admit(eight, busy, head, docs("a")), { kind: "admit" });
  // Running but not busy: still held (SW-675).
  const notBusy = [other, lease("a", 1, 3, "person")];
  assert.deepEqual(admit(eight, notBusy, head, docs("a")), { kind: "wait", position: 2 });
  // Not running: a starved head still gets the next free room (SW-675).
  assert.deepEqual(admit(eight, [other], [w("h", 9)], docs("a")), { kind: "wait", position: 2 });
  // Busy but does not fit: waits, and takes nothing (only the head preempts).
  assert.deepEqual(admit(eight, busy, head, docs("a", 2)), { kind: "wait", position: 2 });
});
