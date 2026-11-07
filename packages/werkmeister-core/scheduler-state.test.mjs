// SW-181: the budget, a feature's cost, the waiting queue, and the gate's
// free-port probe. Running leases come from Docker inspect rows, never a pid.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { readWaiting, waitingPath, writeWaiting } from "./dist/agent_state.js";
import { grantWaiters, runningFeatures } from "./dist/lifecycle.js";
import {
  enqueue,
  featureCost,
  hostLoadLimit,
  loadBudget,
  portHolders,
  readQueue,
  requestAdmission,
  serviceStarts,
  writeLeases,
} from "./dist/scheduler_state.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

const G = 2 ** 30;

async function withHome(fn, config = "") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sched-home-"));
  try {
    return await withSandboxHome(() => fn(home), { config });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function workspace(home, compose) {
  const ws = path.join(home, "ws");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(ws, "compose.yml"), compose);
  return ws;
}

const COMPOSE = `services:
  setup:
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2G }
        reservations: { memory: 512M }
  api:
    ports: ["11102:3999"]
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 1G }
        reservations: { memory: 128M }
  later:
    profiles: ["on-demand"]
    ports: ["11103:3998"]
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 1G }
        reservations: { memory: 1G }
`;

test("budget defaults come from the engine, minus 1G; config overrides; preempt defaults on", async () => {
  await withHome(async () => {
    const b = await loadBudget(async () => ({ MemTotal: 8 * G, NCPU: 12 }));
    assert.deepEqual(b, { memory: 7 * G, cpus: 12, preempt: true });
  });
  await withHome(async () => {
    const b = await loadBudget(async () => ({ MemTotal: 8 * G, NCPU: 12 }));
    assert.deepEqual(b, { memory: 6 * G, cpus: 8, preempt: false });
  }, "budget:\n  memory: 6G\n  cpus: 8\n  preempt: false\n");
});

test("hostLoadLimit: 2 × cores by default, budget.host_load wins, 0 is off, junk falls back (SW-209)", async () => {
  await withHome(async () => assert.equal(hostLoadLimit(12), 24));
  await withHome(async () => assert.equal(hostLoadLimit(12), 30), "budget:\n  host_load: 30\n");
  await withHome(async () => assert.equal(hostLoadLimit(12), 0), "budget:\n  host_load: 0\n");
  await withHome(async () => assert.equal(hostLoadLimit(12), 24), "budget:\n  host_load: lots\n");
  await withHome(async () => assert.equal(hostLoadLimit(12), 24), "budget:\n  host_load: -1\n");
});

test("an unreadable engine and no config means no limit", async () => {
  await withHome(async () => {
    const b = await loadBudget(async () => {
      throw new Error("no daemon");
    });
    assert.equal(b.memory, Infinity);
    assert.equal(b.cpus, Infinity);
  });
});

test("a feature's cost is what up starts: reservations and CPU limits, not on-demand services", async () => {
  await withHome(async (home) => {
    assert.deepEqual(featureCost(workspace(home, COMPOSE)), { memory: 640 * 2 ** 20, cpus: 3 });
  });
});

test("running features' cost comes from Docker inspect rows", () => {
  const rows = [
    "a\t/ws/a\t2026-10-29T10:00:00Z\t536870912\t2000000000",
    "a\t/ws/a\t2026-10-29T10:00:01Z\t134217728\t1000000000",
    "b\t/ws/b\t2026-10-29T10:00:02Z\t0\t0",
  ].join("\n");
  const run = (cmd) =>
    cmd[1] === "ps" ? { status: 0, stdout: "id1\nid2\n" } : { status: 0, stdout: rows };
  const found = runningFeatures(run);
  const a = found.find((f) => f.feature === "a");
  assert.equal(a.memory, 640 * 2 ** 20);
  assert.equal(a.cpus, 3);
  assert.equal(found.find((f) => f.feature === "b").memory, 0);
});

test("no room: the feature queues and gets waiting.json; room: it leaves both", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    const budget = { memory: G, cpus: 4, preempt: true };
    const full = [{ feature: "x", cost: { memory: G, cpus: 1 }, rank: "idle", busy: false }];
    const d = await requestAdmission("f", ws, false, full, budget);
    assert.deepEqual(d, { kind: "wait", position: 1 });
    assert.deepEqual(readQueue(), ["f"]);
    assert.equal(readWaiting(ws).position, 1);

    assert.deepEqual(await requestAdmission("f", ws, false, [], budget), { kind: "admit" });
    assert.deepEqual(readQueue(), []);
    assert.equal(fs.existsSync(waitingPath(ws)), false);
  });
});

// SW-540: since SW-342 every service is on-demand when workspace.yml has no `services:`;
// costing them 0 admitted a wave of 8 onto 12 cores (host load 760).
test("a feature whose services are all on-demand does not cost 0 at admission", async () => {
  await withHome(async (home) => {
    const ws = workspace(
      home,
      `services:
  api:
    profiles: ["on-demand"]
    deploy:
      resources:
        limits: { cpus: "3", memory: 2G }
        reservations: { memory: 768M }
`,
    );
    const budget = { memory: 8 * G, cpus: 4, preempt: true };
    const full = [{ feature: "x", cost: { memory: G, cpus: 4 }, rank: "idle", busy: false }];
    // The gate starting `api` asks for that service by name.
    const starting = { services: ["api"] };
    assert.deepEqual(await requestAdmission("f", ws, false, full, budget, starting), {
      kind: "wait",
      position: 1,
    });
    assert.deepEqual(readWaiting(ws), { position: 1, reason: "waiting for capacity", ...starting });
  });
});

test("a named start prices those services, on-demand or not; serviceStarts adds depends_on", async () => {
  await withHome(async (home) => {
    const ws = workspace(
      home,
      COMPOSE.replace(
        "  later:\n",
        "  later:\n    depends_on: { setup: { condition: service_completed_successfully } }\n",
      ),
    );
    assert.deepEqual(featureCost(ws, ["later"]), { memory: G, cpus: 1 });
    assert.deepEqual(featureCost(ws, ["later", "setup"]), { memory: G + 512 * 2 ** 20, cpus: 3 });
    assert.deepEqual(serviceStarts(ws, "later"), ["later", "setup"]);
    assert.deepEqual(serviceStarts(ws, "api"), ["api"]);
  });
});

test("a service waiter whose poll stopped leaves the queue and its waiting.json; a live one stays (SW-540)", async () => {
  await withHome(async (home) => {
    const dead = workspace(home, COMPOSE);
    const mine = path.join(home, "mine");
    fs.mkdirSync(path.join(mine, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), COMPOSE);
    writeLeases({ dead: { slot: 1, workspace: dead } });
    await enqueue("dead", dead);
    writeWaiting(dead, { position: 1, reason: "waiting for capacity", services: ["api"] });
    const budget = { memory: 8 * G, cpus: 8, preempt: true };
    // Fresh: its poll may still come back, so it keeps the head and mine waits.
    assert.deepEqual(await requestAdmission("mine", mine, false, [], budget), {
      kind: "wait",
      position: 2,
    });
    // Two minutes without a poll rewriting it: the gate was killed.
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(waitingPath(dead), old, old);
    assert.deepEqual(await requestAdmission("mine", mine, false, [], budget), { kind: "admit" });
    assert.deepEqual(readQueue(), []);
    assert.equal(readWaiting(dead), null);
  });
});

// SW-540: during a wave the queue is no longer empty; a start of nothing must not join it.
test("a request that starts nothing admits and leaves the queue and waiting.json alone", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, 'services:\n  api:\n    profiles: ["on-demand"]\n');
    await enqueue("ahead", ws);
    const gateWait = {
      position: 1,
      reason: "waiting for capacity",
      services: ["api"],
    };
    writeWaiting(ws, gateWait);
    const budget = { memory: G, cpus: 1, preempt: true };
    assert.deepEqual(await requestAdmission("f", ws, false, [], budget), { kind: "admit" });
    assert.deepEqual(readQueue(), ["ahead"]);
    assert.deepEqual(readWaiting(ws), gateWait);
  });
});

// SW-246: no .werkmeister/ means waiting.json can't be written; the queue must not move.
test("requestAdmission: a failed waiting.json write leaves queue.json as it was", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    fs.rmSync(path.join(ws, ".werkmeister"), { recursive: true });
    const budget = { memory: G, cpus: 4, preempt: true };
    const full = [{ feature: "x", cost: { memory: G, cpus: 1 }, rank: "idle", busy: false }];
    await assert.rejects(requestAdmission("f", ws, false, full, budget), { code: "ENOENT" });
    assert.deepEqual(readQueue(), []);
  });
});

test("enqueue: a failed waiting.json write leaves queue.json as it was", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    fs.rmSync(path.join(ws, ".werkmeister"), { recursive: true });
    await assert.rejects(enqueue("f", ws), { code: "ENOENT" });
    assert.deepEqual(readQueue(), []);
  });
});

test("portHolders reports a published port something else binds", async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "0.0.0.0", r));
  const port = srv.address().port;
  try {
    await withHome(async (home) => {
      const ws = workspace(home, `services:\n  api:\n    ports: ["${port}:3999"]\n`);
      const clash = await portHolders("f", ws);
      assert.equal(clash.length, 1);
      assert.equal(clash[0].port, port);
    });
  } finally {
    srv.close();
  }
  await withHome(async (home) => {
    const ws = workspace(home, `services:\n  api:\n    ports: ["${port}:3999"]\n`);
    assert.deepEqual(await portHolders("f", ws), []);
  });
});

test("grantWaiters drops a waiter that holds no lease and starts nothing", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    await enqueue("orphan", ws);
    assert.deepEqual(await grantWaiters(), []);
    assert.deepEqual(readQueue(), []);
  });
});

test("grantWaiters dequeues a waiter with no local services once up starts it (SW-245)", async () => {
  const prev = process.env.WERKMEISTER_FIXTURE;
  process.env.WERKMEISTER_FIXTURE = "1"; // Caddy skipped: nothing here touches Docker
  try {
    await withHome(async (home) => {
      const ws = workspace(home, "services: {}\n");
      fs.writeFileSync(path.join(ws, ".env"), "FEATURE=k8s\nSLOT=4\n"); // no SERVICES=
      writeLeases({ k8s: { slot: 4, workspace: ws } });
      await enqueue("k8s", ws);
      assert.deepEqual(await grantWaiters(), ["k8s"]);
      assert.deepEqual(readQueue(), []);
      assert.equal(fs.existsSync(waitingPath(ws)), false);
      // A later grant has nothing left to re-up.
      assert.deepEqual(await grantWaiters(), []);
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_FIXTURE;
    else process.env.WERKMEISTER_FIXTURE = prev;
  }
});
