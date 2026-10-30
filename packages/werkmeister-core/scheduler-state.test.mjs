// SW-181: the budget, a feature's cost, the waiting queue, and the gate's
// free-port probe. Running leases come from Docker inspect rows, never a pid.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { readWaiting, waitingPath } from "./dist/agent_state.js";
import { runningFeatures } from "./dist/lifecycle.js";
import {
  featureCost,
  loadBudget,
  portHolders,
  readQueue,
  requestAdmission,
} from "./dist/scheduler_state.js";
import { withSandboxHome } from "./fixtures.mjs";

const G = 2 ** 30;

async function withHome(fn, config = "") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sched-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await withSandboxHome(() => fn(home), { config });
  } finally {
    process.env.HOME = prev;
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
