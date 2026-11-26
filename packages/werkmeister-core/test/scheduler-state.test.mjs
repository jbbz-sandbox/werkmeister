// SW-181: the budget, a feature's cost, the waiting queue, and the gate's
// free-port probe. Running leases come from Docker inspect rows, never a pid.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  readNudge,
  readWaiting,
  waitingPath,
  writeLastStop,
  writeWaiting,
} from "../dist/agent_state.js";
import { loadPorts, loadServices } from "../dist/config.js";
import { generateFeatureCompose } from "../dist/generate.js";
import { grantWaiters, runningFeatures, runningLeases, up } from "../dist/lifecycle.js";
import { workspaceServices } from "../dist/registry_sync.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { admit } from "../dist/scheduler.js";
import {
  dequeue,
  enqueue,
  featureCost,
  hostLoadLimit,
  loadBudget,
  portHolders,
  queuePath,
  readQueue,
  readVmLoad,
  requestAdmission,
  serviceStarts,
  sweepVmLoadProbes,
  waitForSetupLoad,
  writeLeases,
} from "../dist/scheduler_state.js";
import {
  pinWerkmeisterRoot,
  queueWorkspace,
  withFixtureWorkspace,
  withSandboxHome,
  writeSessionState,
} from "./fixtures.mjs";

pinWerkmeisterRoot();

const G = 2 ** 30;

async function withHome(fn, config = "", services = undefined) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sched-home-"));
  try {
    return await withSandboxHome(() => fn(home), { config, services });
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

// SW-992: CPUs default to no limit (load gates the CPU-heavy steps); summing limits queued 7 workspaces on an idle VM.
test("budget memory defaults to the engine's minus 1G, CPUs to no limit; config overrides; preempt on", async () => {
  await withHome(async () => {
    const b = await loadBudget(async () => ({ MemTotal: 8 * G, NCPU: 12 }));
    assert.deepEqual(b, { memory: 7 * G, cpus: Infinity, preempt: true });
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
  let format = "";
  const run = (cmd) => {
    if (cmd[1] === "ps") return { status: 0, stdout: "id1\nid2\n" };
    format = cmd[3];
    return { status: 0, stdout: rows };
  };
  const found = runningFeatures(run);
  // SW-972: a bare `len .ExecIDs` fails the inspect for a container with no exec in flight.
  assert.match(format, /\{\{if \.ExecIDs\}\}\{\{len \.ExecIDs\}\}\{\{else\}\}0\{\{end\}\}/);
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

// SW-682: never-fits must stay in the dequeue branch; in the wait branch it would be a dead queue head again (SW-629).
test("a queued feature that can never fit leaves the queue and its waiting.json", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    await enqueue("f", ws);
    const d = await requestAdmission("f", ws, false, [], { memory: G, cpus: 0.5, preempt: true });
    assert.equal(d.kind, "never-fits");
    assert.deepEqual(readQueue(), []);
    assert.equal(readWaiting(ws), null);
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
    // Working, or the start would take its lease (SW-546) instead of showing the price.
    const full = [{ feature: "x", cost: { memory: G, cpus: 4 }, rank: "working", busy: false }];
    // The gate starting `api` asks for that service by name.
    const starting = { services: ["api"] };
    assert.deepEqual(await requestAdmission("f", ws, false, full, budget, starting), {
      kind: "wait",
      position: 1,
    });
    const first = readWaiting(ws);
    assert.deepEqual(
      { ...first, since: undefined },
      { position: 1, reason: "waiting for capacity", ...starting, since: undefined },
    );
    // T6. SW-675: the first wait's time survives each re-poll; the starvation bound reads it.
    assert.match(first.since, /^\d{4}-\d\d-\d\dT/);
    await requestAdmission("f", ws, false, full, budget, starting);
    assert.equal(readWaiting(ws).since, first.since);
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
    // Waited past the starvation bound (SW-675), so a live head holds the room against backfill.
    const since = new Date(Date.now() - 11 * 60_000).toISOString();
    writeWaiting(dead, { position: 1, reason: "waiting for capacity", services: ["api"], since });
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

// SW-701: a parked start has no poll by design; dropping it as dead would lose its place again.
test("a parked service waiter is not dropped for its old file, and a starved one does not hold", async () => {
  await withHome(async (home) => {
    const parked = workspace(home, COMPOSE);
    const mine = path.join(home, "mine");
    fs.mkdirSync(path.join(mine, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), COMPOSE);
    writeLeases({ parked: { slot: 1, workspace: parked } });
    await enqueue("parked", parked);
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    writeWaiting(parked, {
      position: 1,
      reason: "waiting for capacity",
      services: ["api"],
      since,
      parked: { service: "api" },
    });
    const old = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(waitingPath(parked), old, old);
    // Waited an hour, past STARVE_MS: only its parked flag keeps it from holding mine (the pure
    // `admit` test covers one that cannot fit). It stays queued for its grant.
    const budget = { memory: 8 * G, cpus: 8, preempt: true };
    assert.deepEqual(await requestAdmission("mine", mine, false, [], budget), { kind: "admit" });
    assert.deepEqual(readQueue(), ["parked"]);
    assert.equal(readWaiting(parked)?.parked?.service, "api");
  });
});

// SW-729: a queued whole-feature `up` has no poll of its own; only a release's grant starts it.
test("a starved whole-feature head that fits passes a service start on an idle host and stays queued", async () => {
  await withHome(async (home) => {
    const head = workspace(home, COMPOSE);
    const mine = path.join(home, "mine");
    fs.mkdirSync(path.join(mine, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), COMPOSE);
    writeLeases({ head: { slot: 1, workspace: head } });
    await enqueue("head", head);
    const since = new Date(Date.now() - 239 * 60_000).toISOString();
    writeWaiting(head, { position: 1, reason: "waiting for capacity", since });
    const budget = { memory: 8 * G, cpus: 4, preempt: false };
    const start = { services: ["api"] };
    // 3 of 4 CPUs taken by a run that ends by itself: the head (3 CPUs) can't fit, so it keeps the room.
    const busy = [{ feature: "x", cost: { memory: G, cpus: 3 }, rank: "working", busy: false }];
    assert.deepEqual(await requestAdmission("mine", mine, false, busy, budget, start), {
      kind: "wait",
      position: 2,
    });
    assert.deepEqual(await requestAdmission("mine", mine, false, [], budget, start), {
      kind: "admit",
    });
    assert.deepEqual(readQueue(), ["head"]);
    assert.equal(readWaiting(head).since, since);
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

// SW-737: a head whose re-up throws (HOST_LOAD, NO_COMPOSE, ...) aborted the whole pass, so every
// tick failed on it and the waiters behind it were never started, on an idle host too.
test("grantWaiters starts the waiters behind a head whose up throws, and keeps that head queued", async () => {
  const prev = process.env.WERKMEISTER_FIXTURE;
  process.env.WERKMEISTER_FIXTURE = "1";
  try {
    await withHome(async (home) => {
      const k8s = workspace(home, "services: {}\n");
      fs.writeFileSync(path.join(k8s, ".env"), "FEATURE=k8s\nSLOT=4\n");
      const broken = path.join(home, "broken");
      fs.mkdirSync(path.join(broken, ".werkmeister"), { recursive: true }); // no compose.yml: up throws
      writeLeases({ broken: { slot: 3, workspace: broken }, k8s: { slot: 4, workspace: k8s } });
      await enqueue("broken", broken);
      await enqueue("k8s", k8s);
      assert.deepEqual(await grantWaiters(), ["k8s"]);
      assert.deepEqual(readQueue(), ["broken"]);
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_FIXTURE;
    else process.env.WERKMEISTER_FIXTURE = prev;
  }
});

// SW-682: a head queued before the budget shrank threw NEVER_FITS out of the pass; its session was never told.
test("grantWaiters drops a head that can never fit, tells its session, and starts the next", async () => {
  const prev = {
    fixture: process.env.WERKMEISTER_FIXTURE,
    docker: process.env.WERKMEISTER_DOCKER_BIN,
  };
  process.env.WERKMEISTER_FIXTURE = "1";
  try {
    await withHome(
      async (home) => {
        const fake = path.join(home, "docker");
        fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // reads as: nothing runs
        process.env.WERKMEISTER_DOCKER_BIN = fake;
        const k8s = workspace(home, "services: {}\n");
        fs.writeFileSync(path.join(k8s, ".env"), "FEATURE=k8s\nSLOT=4\n");
        const big = path.join(home, "big");
        fs.mkdirSync(path.join(big, ".werkmeister"), { recursive: true });
        fs.writeFileSync(path.join(big, ".env"), "FEATURE=big\nWERKMEISTER_SLOT=3\nSERVICES=big\n");
        // Rendered as up renders it, so up finds it current and prices its 9 CPUs.
        const config = { services: workspaceServices(loadServices(), big), ports: loadPorts() };
        generateFeatureCompose("big", 3, ["big"], config, big, "werkmeister CLI");
        writeLeases({ big: { slot: 3, workspace: big }, k8s: { slot: 4, workspace: k8s } });
        await enqueue("big", big);
        await enqueue("k8s", k8s);
        assert.deepEqual(await grantWaiters(), ["k8s"]);
        assert.deepEqual(readQueue(), []);
        assert.match(readNudge(big), /'big' can never fit the budget/);
        assert.doesNotMatch(readNudge(big), /queue it again/); // a rerun would fail the same way (SW-848)
      },
      "budget:\n  cpus: 4\n  memory: 8G\n",
      "services:\n  big:\n    type: api\n    repo: demo-repo\n    port_offset: 2\n    cpus: 9\n",
    );
  } finally {
    for (const [k, v] of [
      ["WERKMEISTER_FIXTURE", prev.fixture],
      ["WERKMEISTER_DOCKER_BIN", prev.docker],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// SW-848: two 3-CPU holders fill an 8-CPU budget, a 5-CPU `up` queues at position 1, the holders stop and
// the grant runs. *between* runs after the stop, before the grant.
async function queuedBehindHolders(between, check) {
  const holder = (n) => ({
    feature: `holder-${n}`,
    workspace: `holder-${n}`,
    startedAt: "2026-11-16T00:00:00Z",
    memory: G,
    nanoCpus: 3e9,
  });
  await withFixtureWorkspace(
    async (fx) => {
      const ws = path.join(fx.root, "ws", "big");
      fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".env"), "FEATURE=big\nWERKMEISTER_SLOT=3\nSERVICES=big\n");
      const config = { services: workspaceServices(loadServices(), ws), ports: loadPorts() };
      generateFeatureCompose("big", 3, ["big"], config, ws, "werkmeister CLI");
      writeSessionState(ws, "done");
      const r = await withReporter(collectingReporter().reporter, () =>
        up("big", ws, { byPerson: false }),
      );
      assert.equal(r.waiting, 1);
      assert.deepEqual(readQueue(), ["big"]);
      fs.writeFileSync(path.join(fx.root, "bin", "containers"), ""); // the holders stop
      between?.(fx);
      await check(await withReporter(collectingReporter().reporter, grantWaiters), ws);
    },
    {
      containers: [holder(1), holder(2)],
      config: { budget: { cpus: 8, memory: "16G" } },
      services:
        "services:\n  big:\n    type: api\n    repo: app\n    port_offset: 2\n    cpus: 5\n",
    },
  );
}

test("a feature queued behind two holders starts when they stop, and its session is told (SW-848)", () =>
  queuedBehindHolders(undefined, (started, ws) => {
    assert.deepEqual(started, ["big"]);
    assert.deepEqual(readQueue(), []);
    assert.equal(fs.existsSync(waitingPath(ws)), false);
    assert.match(readNudge(ws), /Capacity freed/);
  }));

test("a waiter whose start fails after admission dropped it is told to rerun up (SW-848)", () =>
  queuedBehindHolders(
    (fx) => {
      const docker = path.join(fx.root, "bin", "docker");
      const sh = fs
        .readFileSync(docker, "utf8")
        .replace(
          "stop|compose|network) ;;",
          'compose) case "$*" in *" up "*) exit 1 ;; esac ;;\n    stop|network) ;;',
        );
      fs.writeFileSync(docker, sh);
    },
    (started, ws) => {
      assert.deepEqual(started, []);
      assert.deepEqual(readQueue(), []);
      assert.equal(fs.existsSync(waitingPath(ws)), false);
      assert.match(readNudge(ws) ?? "", /Could not start 'big'.*werkmeister feature up/s);
    },
  ));

test("a waiter whose lease is gone is started from its workspace, not dropped (SW-848)", () =>
  queuedBehindHolders(
    () => writeLeases({}),
    (started, ws) => {
      assert.deepEqual(started, ["big"]);
      assert.deepEqual(readQueue(), []);
      assert.equal(fs.existsSync(waitingPath(ws)), false);
    },
  ));

// SW-630: a setup service's install ran 78 min at load ~413 and compose's --wait gave up at 20 min.
const SETUP_COMPOSE = `services:
  install:
    labels: { com.werkmeister.role: setup }
  api:
    depends_on: { install: { condition: service_completed_successfully } }
  db: {}
`;

// Saved and restored, so a failing assert leaves WERKMEISTER_NO_WAIT as it was for later tests (SW-671).
async function withNoWait(value, fn) {
  const prev = process.env.WERKMEISTER_NO_WAIT;
  if (value === undefined) delete process.env.WERKMEISTER_NO_WAIT;
  else process.env.WERKMEISTER_NO_WAIT = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_NO_WAIT;
    else process.env.WERKMEISTER_NO_WAIT = prev;
  }
}

/** A fake host (or, on macOS and Windows, Docker VM) load reading *loads* in turn (the last repeats) on 4 cores: limit 8. */
function hostLoads(...loads) {
  const slept = [];
  let i = 0;
  const read = () => {
    const l = loads[Math.min(i++, loads.length - 1)];
    return { load: [l, l, l], cores: 4 };
  };
  return {
    slept,
    hostLoad: read,
    vmLoad: async () => read(),
    hostMemory: () => ({ free: 8, total: 16 }),
    sleep: async (ms) => slept.push(ms),
  };
}

test("waitForSetupLoad: load still over budget after the wait fails with the load, not a compose timeout (SW-630)", async () => {
  await withNoWait(undefined, () =>
    withHome(async (home) => {
      const ws = workspace(home, SETUP_COMPOSE);
      const lines = [];
      const stuck = hostLoads(90);
      await assert.rejects(
        withReporter({ emit: (e) => lines.push(e.msg) }, () =>
          waitForSetupLoad(ws, serviceStarts(ws, "api"), stuck, "linux"),
        ),
        (e) =>
          e.code === "HOST_LOAD" &&
          /host load 90\.0 is over 8 \(budget\.host_load\)/.test(e.message) &&
          /install/.test(e.message),
      );
      assert.equal(stuck.slept.length, 6);
      assert.match(
        lines[0],
        /waiting up to 1\.5 min for host load 90\.0 to fall to 8 \(budget\.host_load\) before starting install/,
      );
    }),
  );
});

// SW-620: on macOS low free memory holds the install back too, with the Docker VM idle.
test("waitForSetupLoad: low free memory after the wait fails with the memory, on macOS too (SW-620)", async () => {
  await withNoWait(undefined, () =>
    withHome(async (home) => {
      const ws = workspace(home, SETUP_COMPOSE);
      const short = {
        ...hostLoads(500),
        vmLoad: async () => ({ load: [1, 1, 1], cores: 4 }),
        hostMemory: () => ({ free: 1, total: 16 }),
      };
      await assert.rejects(
        waitForSetupLoad(ws, serviceStarts(ws, "api"), short, "darwin"),
        (e) =>
          e.code === "HOST_LOAD" &&
          /^memory is low \(6% free, under budget\.free_memory 15%\)/.test(e.message) &&
          !/host load/.test(e.message),
      );
    }),
  );
});

test("waitForSetupLoad: starts once load falls, and at once when under budget (SW-630)", async () => {
  await withNoWait(undefined, () =>
    withHome(async (home) => {
      const ws = workspace(home, SETUP_COMPOSE);
      const falls = hostLoads(90, 1);
      await waitForSetupLoad(ws, serviceStarts(ws, "api"), falls, "linux");
      assert.deepEqual(falls.slept, [15000]);
      const calm = hostLoads(1);
      await waitForSetupLoad(ws, undefined, calm, "linux"); // a whole `up` starts the install too
      assert.deepEqual(calm.slept, []);
    }),
  );
});

test("waitForSetupLoad: no setup among the starts, or WERKMEISTER_NO_WAIT: no wait (SW-630)", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, SETUP_COMPOSE);
    for (const [services, platform, noWait] of [
      [serviceStarts(ws, "db"), "linux", false],
      [["api"], "linux", false], // --no-deps: the install is current, so not started
      [serviceStarts(ws, "api"), "linux", true],
    ]) {
      const stuck = hostLoads(90);
      await withNoWait(noWait ? "1" : undefined, () =>
        waitForSetupLoad(ws, services, stuck, platform),
      );
      assert.deepEqual(stuck.slept, [], `${services} on ${platform}`);
    }
  });
});

/** A host whose own loadavg reads *mac* while its Docker VM reads *vm* (null: unreadable) on 12 cores: limit 24. */
const vmHost = (mac, vm) => ({
  ...hostLoads(mac),
  vmLoad: async () => (vm === null ? null : { load: [vm, vm, vm], cores: 12 }),
});

// SW-888: macOS's loadavg never sees the VM, and Windows' is always 0, so both read the VM's own load.
for (const platform of ["darwin", "win32"]) {
  test(`waitForSetupLoad: on ${platform} a busy Docker VM holds back the setup start (SW-888)`, async () => {
    await withNoWait(undefined, () =>
      withHome(async (home) => {
        const ws = workspace(home, SETUP_COMPOSE);
        const busy = vmHost(0, 90);
        await assert.rejects(
          waitForSetupLoad(ws, serviceStarts(ws, "api"), busy, platform),
          (e) =>
            e.code === "HOST_LOAD" &&
            /host load 90\.0 is over 24 \(budget\.host_load\)/.test(e.message),
        );
        assert.deepEqual(busy.slept, Array(6).fill(15_000));
      }),
    );
  });
}

test("waitForSetupLoad: on macOS an idle or unreadable Docker VM admits at once, whatever loadavg reads (SW-888)", async () => {
  await withNoWait(undefined, () =>
    withHome(async (home) => {
      const ws = workspace(home, SETUP_COMPOSE);
      for (const vm of [1, null]) {
        const host = vmHost(500, vm); // 500: the SW-556 macOS loadavg on a quiet host
        await waitForSetupLoad(ws, serviceStarts(ws, "api"), host, "darwin");
        assert.deepEqual(host.slept, [], `VM ${vm}`);
      }
    }),
  );
});

test("readVmLoad: parses the VM's loadavg and nproc; a failed or junk run is null (SW-888)", async () => {
  const prev = process.env.WERKMEISTER_DOCKER_BIN;
  try {
    await withHome(async (home) => {
      const fake = path.join(home, "docker");
      const as = (body) => {
        fs.writeFileSync(fake, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        process.env.WERKMEISTER_DOCKER_BIN = fake;
      };
      const argsFile = path.join(home, "args");
      as(`printf '%s\\n' "$@" > '${argsFile}'\nprintf '0.52 0.40 0.31 2/300 9\\n12\\n'`);
      assert.deepEqual(await readVmLoad(), { load: [0.52, 0.4, 0.31], cores: 12 });
      // SW-969: dropping --rm, --network none or the label (which machine clean sweeps by) must fail here.
      const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
      assert.deepEqual(args.slice(0, args.indexOf("alpine:3") + 1), [
        "run",
        "--rm",
        "--network",
        "none",
        "--label",
        "com.werkmeister.role=vm-load",
        "alpine:3",
      ]);
      as("exit 1");
      assert.equal(await readVmLoad(), null);
      as("echo nope");
      assert.equal(await readVmLoad(), null);
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_BIN;
    else process.env.WERKMEISTER_DOCKER_BIN = prev;
  }
});

// SW-969: a probe killed between create and start is left Created on the shared daemon; machine clean sweeps
// only probes by their label, Created or exited, never a running one.
test("sweepVmLoadProbes: removes labelled probes left Created or exited; a dry run only lists", async () => {
  const prev = process.env.WERKMEISTER_DOCKER_BIN;
  try {
    await withHome(async (home) => {
      const fake = path.join(home, "docker");
      const log = path.join(home, "docker.log");
      fs.writeFileSync(
        fake,
        `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1" = ps ] && printf 'c1\\nc2\\n'\nexit 0\n`,
        { mode: 0o755 },
      );
      process.env.WERKMEISTER_DOCKER_BIN = fake;
      assert.deepEqual(sweepVmLoadProbes(true), ["c1", "c2"]);
      assert.doesNotMatch(fs.readFileSync(log, "utf8"), /^rm/m);
      assert.deepEqual(sweepVmLoadProbes(), ["c1", "c2"]);
      const calls = fs.readFileSync(log, "utf8").trim().split("\n");
      assert.equal(
        calls[0],
        "ps -aq --filter label=com.werkmeister.role=vm-load --filter status=created --filter status=exited",
      );
      assert.equal(calls.at(-1), "rm c1 c2");
      process.env.WERKMEISTER_DOCKER_BIN = path.join(home, "missing");
      assert.deepEqual(sweepVmLoadProbes(), []);
    });
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_BIN;
    else process.env.WERKMEISTER_DOCKER_BIN = prev;
  }
});

// SW-681: an autonomous workspace whose stopped turn left a background shell running (a gate, pr open)
// ranks working, not idle, so preemption doesn't stop it under that run.
test("preemption rank: a stopped session with a live background shell is working, without one idle", async () => {
  await withHome(async (home) => {
    const ws = path.join(home, "features", "auto");
    const sessions = path.join(ws, ".werkmeister", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "autonomous: true\n");
    const at = new Date(Date.now() - 60_000).toISOString();
    const stopped = { status: "idle", at, last: at, stopped: true };
    const run = (cmd) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\n" }
        : { status: 0, stdout: `auto\t${ws}\t2026-10-29T10:00:00Z\t0\t0` };
    const rank = () => runningLeases(run).find((l) => l.feature === "auto").rank;

    fs.writeFileSync(path.join(sessions, "s.json"), JSON.stringify(stopped));
    assert.equal(rank(), "idle");
    const shell = { command: "werkmeister pr gate --tests", at, id: "b1" };
    fs.writeFileSync(path.join(sessions, "s.json"), JSON.stringify({ ...stopped, shell }));
    assert.equal(rank(), "working");
  });
});

// SW-856: a `docker exec` still running in a feature's container (a test run, a probe) is work in
// flight, whatever its session's hook record says: preemption must not stop that feature.
test("preemption: a feature with a docker exec in flight is never a victim (SW-856)", async () => {
  await withHome(async (home) => {
    const ws = path.join(home, "features", "auto");
    fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "autonomous: true\n");
    // Docker's `.ExecIDs` lists the container's running execs; the last column is their count.
    const run = (execs) => (cmd) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\n" }
        : { status: 0, stdout: `auto\t${ws}\t2026-10-29T10:00:00Z\t${G}\t4000000000\t${execs}` };
    const budget = { memory: 8 * G, cpus: 6, preempt: true };
    const req = { feature: "other", cost: { memory: G, cpus: 4 }, byPerson: true };
    assert.deepEqual(admit(budget, runningLeases(run(0)), [], req), {
      kind: "preempt",
      victims: ["auto"],
    });
    assert.equal(runningLeases(run(1))[0].busy, true);
    assert.deepEqual(admit(budget, runningLeases(run(1)), [], req), { kind: "wait", position: 1 });
  });
});

// SW-861: the grant runs in another process (a stop, a down, the daemon), so its compose output never
// reaches the queued session: its nudge must name where the error is, not "above".
test("a waiter whose compose up fails in the grant is told where to read why (SW-861)", () =>
  queuedBehindHolders(
    (fx) => {
      const docker = path.join(fx.root, "bin", "docker");
      const sh = fs
        .readFileSync(docker, "utf8")
        .replace(
          "stop|compose|network) ;;",
          'compose) case "$*" in *" up "*) exit 1 ;; esac ;;\n    stop|network) ;;',
        );
      fs.writeFileSync(docker, sh);
    },
    (_started, ws) => {
      assert.doesNotMatch(readNudge(ws) ?? "", /above/);
      assert.match(readNudge(ws) ?? "", /werkmeister feature logs big/);
    },
  ));

// SW-863: an admit that returns before the locked one (Docker unreadable here) started the containers but
// left queue.json and waiting.json, so the hook kept saying "queued" over a running feature.
test("an up admitted with Docker unreadable leaves the queue and waiting.json once it starts (SW-863)", () =>
  queuedBehindHolders(
    (fx) => {
      const docker = path.join(fx.root, "bin", "docker");
      const sh = fs
        .readFileSync(docker, "utf8")
        .replace(
          '"ps -q --filter label=com.werkmeister.feature")',
          '"ps -q --filter label=com.werkmeister.feature") exit 1 ;;\n        "ps -q unused")',
        );
      fs.writeFileSync(docker, sh);
    },
    (started, ws) => {
      assert.deepEqual(started, ["big"]);
      assert.deepEqual(readQueue(), []);
      assert.equal(fs.existsSync(waitingPath(ws)), false);
    },
  ));

// SW-702: a preempted session heard "Capacity freed" and nothing about why it had been down.
test("the grant's nudge names why werkmeister stopped the feature and what it killed, once (SW-702)", () =>
  queuedBehindHolders(
    (fx) =>
      writeLastStop(path.join(fx.root, "ws", "big"), {
        at: "2026-11-18T00:00:00Z",
        why: "preempted to make room for 'other'",
        killed: ["pnpm test"],
      }),
    (_started, ws) => {
      assert.match(
        readNudge(ws) ?? "",
        /^Werkmeister had stopped it \(preempted to make room for 'other'\), killing `pnpm test`: rerun them\. Capacity freed/,
      );
      assert.equal(fs.existsSync(path.join(ws, ".werkmeister", "last-stop.json")), false);
    },
  ));

// Review (SW-702): a record no grant reported (its session had ended) was told on a much later, unrelated grant.
test("a start drops a stop record no grant reported, so a later grant can't report it stale (SW-702)", () =>
  queuedBehindHolders(undefined, async (_started, ws) => {
    const record = path.join(ws, ".werkmeister", "last-stop.json");
    writeLastStop(ws, { at: "2026-11-16T00:00:00Z", why: "idle ≥ 10 min", killed: [] });
    await withReporter(collectingReporter().reporter, () => up("big", ws, { byPerson: false }));
    assert.equal(fs.existsSync(record), false);
  }));

// SW-909: a plain `up` of a feature that already runs priced its exited setup one-shot, so it could wait
// behind a holding head; the wait wrote a whole-feature waiting.json and queued it over live containers,
// and the hook then held every docker/pnpm/node call of its session.
test("a re-up of a running feature that must wait leaves no waiting.json and no queue entry (SW-909)", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    const budget = { memory: 4 * G, cpus: 4, preempt: true };
    // `api` runs (1 CPU); `setup` exited, so the re-up adds 2 CPUs on a host with 1 free.
    const running = [
      { feature: "f", cost: { memory: 128 * 2 ** 20, cpus: 1 }, rank: "working", busy: false },
      { feature: "x", cost: { memory: G, cpus: 2 }, rank: "person", busy: false },
    ];
    await requestAdmission("f", ws, false, running, budget);
    assert.deepEqual(readQueue(), []);
    assert.equal(fs.existsSync(waitingPath(ws)), false);
  });
});

// SW-986 (review): the hook clears waiting.json over running containers; the queue entry it leaves must
// not hold the head for a feature that already runs. A waiter with its waiting.json stays.
test("admission drops a queued feature whose waiting.json is gone; a live waiter stays", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    const stale = path.join(home, "stale");
    const live = path.join(home, "live");
    for (const d of [stale, live]) fs.mkdirSync(path.join(d, ".werkmeister"), { recursive: true });
    fs.writeFileSync(waitingPath(live), JSON.stringify({ position: 2, reason: "preempted" }));
    writeLeases({ stale: { slot: 1, workspace: stale }, live: { slot: 2, workspace: live } });
    await enqueue("stale", stale);
    fs.rmSync(waitingPath(stale));
    await enqueue("live", live);
    await requestAdmission("f", ws, false, [], { memory: 64 * G, cpus: 64, preempt: false });
    assert.deepEqual(readQueue(), ["live"]);
  });
});

// SW-910: a session on a tool-permission prompt is mid-turn (the prompted command is often a
// `docker exec` into this very feature), not a session handed to the person: preemption must skip it.
test("preemption rank: a permission prompt mid-turn is working; a question is human-check (SW-910)", async () => {
  await withHome(async (home) => {
    const ws = path.join(home, "features", "auto");
    const sessions = path.join(ws, ".werkmeister", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "autonomous: true\n");
    const at = new Date(Date.now() - 60_000).toISOString();
    const run = (cmd) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\n" }
        : { status: 0, stdout: `auto\t${ws}\t2026-10-29T10:00:00Z\t0\t0\t0` };
    const rank = (kind) => {
      const ask = { kind, what: "Approve Bash?", at, source: "session" };
      fs.writeFileSync(
        path.join(sessions, "s.json"),
        JSON.stringify({ status: "busy", at, last: at, ask }),
      );
      return runningLeases(run).find((l) => l.feature === "auto").rank;
    };
    assert.equal(rank("permission"), "working");
    assert.equal(rank("question"), "human-check");
  });
});

// SW-907 (1): an on-demand service running beside the feature was subtracted from a plain `up`'s
// cost, though `up` starts none of it: `docs` (1 CPU) running made a 3-CPU `up` cost 2.
test("a plain up beside a running on-demand service prices every up service it starts (SW-907)", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    const budget = { memory: 8 * G, cpus: 3.5, preempt: false };
    const running = [
      {
        feature: "f",
        cost: { memory: G, cpus: 1 },
        rank: "working",
        busy: false,
        services: ["later"],
      },
    ];
    // 1 running + 3 to start = 4 CPUs > 3.5.
    assert.equal((await requestAdmission("f", ws, false, running, budget)).kind, "wait");
  });
});

// SW-907 (2): a running feature is priced at its live limits, admission at compose's; a container
// started with no limit (an older compose) read as free.
test("a running feature costs at least what compose reserves for its running services (SW-907)", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    const run = (cmd) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\n" }
        : { status: 0, stdout: `f\t${ws}\t2026-10-29T10:00:00Z\t0\t0\t0\tapi` };
    const lease = runningLeases(run).find((l) => l.feature === "f");
    assert.deepEqual(lease.cost, { memory: 128 * 2 ** 20, cpus: 1 });
  });
});

// SW-907 (3): admission saw only running containers, so two admits before either one's containers
// existed both fit the same room.
test("two admits before either feature's containers run cannot both take the same room (SW-907)", async () => {
  await withHome(async (home) => {
    const mk = (name) => {
      const ws = path.join(home, name);
      fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
      fs.writeFileSync(path.join(ws, "compose.yml"), COMPOSE);
      return ws;
    };
    const budget = { memory: 8 * G, cpus: 4, preempt: false };
    assert.deepEqual(await requestAdmission("f", mk("wf"), false, [], budget), { kind: "admit" });
    // f's 3 CPUs are admitted but not yet running: g's 3 more do not fit 4.
    const wg = mk("wg");
    assert.equal((await requestAdmission("g", wg, false, [], budget)).kind, "wait");
    // f asking again does not count its own reservation; once its start settles, g fits.
    assert.deepEqual(await requestAdmission("f", path.join(home, "wf"), false, [], budget), {
      kind: "admit",
    });
    await dequeue("f");
    assert.deepEqual(await requestAdmission("g", wg, false, [], budget), { kind: "admit" });
  });
});

// SW-989: a budget for one feature and three starved autonomous waiters. The grant pass admits the head, then
// asks for the next one at once; the one it just started ranks idle (its session has had no turn), so the next
// head preempted it, and so on down the queue. They must run one after another, each to its release.
test("three waiters for a one-feature budget run one after another, head first, none preempted (SW-989)", async () => {
  await withHome(async (home) => {
    const budget = { memory: 8 * G, cpus: 3, preempt: true }; // COMPOSE costs 3 CPUs
    const since = new Date(Date.now() - 10 * 60_000).toISOString(); // past STARVE_MS
    const ws = {};
    const leases = {};
    for (const [i, f] of ["a", "b", "c"].entries()) {
      ws[f] = path.join(home, "features", f);
      fs.mkdirSync(path.join(ws[f], ".werkmeister", "sessions"), { recursive: true });
      fs.writeFileSync(path.join(ws[f], "compose.yml"), COMPOSE);
      fs.writeFileSync(path.join(ws[f], ".werkmeister", "workspace.yml"), "autonomous: true\n");
      fs.writeFileSync(path.join(ws[f], ".env"), `FEATURE=${f}\n`);
      // Held as queued since long ago: its session's last record is old and idle.
      writeSessionState(ws[f], "done", { at: since });
      writeWaiting(ws[f], { position: i + 1, reason: "preempted", since });
      leases[f] = { slot: i + 1, workspace: ws[f] };
    }
    writeLeases(leases);
    fs.writeFileSync(queuePath(), JSON.stringify(["a", "b", "c"]));
    // What Docker shows: *f*'s containers, started just now.
    const runs = (f) => (cmd) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: f ? "id1\n" : "" }
        : { status: 0, stdout: `${f}\t${ws[f]}\t${new Date().toISOString()}\t0\t3000000000\t0` };
    const ask = (f, running) =>
      requestAdmission(f, ws[f], false, runningLeases(runs(running)), budget);

    const order = [];
    let running = null;
    for (let turn = 0; turn < 3; turn++) {
      // The grant pass: each waiter in queue order asks, as grantWaitersNow does.
      for (const f of readQueue()) {
        const d = await ask(f, running);
        assert.notEqual(d.kind, "preempt", `${f} preempted ${d.victims} admitted moments ago`);
        if (d.kind === "admit") {
          order.push(f);
          await dequeue(f); // its start succeeded, as up() records it
          running = f;
        }
      }
      running = null; // it ran to its release
    }
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.deepEqual(readQueue(), []);
  });
});

// SW-989: the hold is the newest container start within STARVE_MS; past it the session's own rank stands.
test("preemption rank: a feature started within STARVE_MS is working, past it its session decides (SW-989)", async () => {
  await withHome(async (home) => {
    const ws = path.join(home, "features", "auto");
    fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "autonomous: true\n");
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const rank = (agent, minutesAgo) => {
      writeSessionState(ws, agent, { at: old });
      // One container per entry: *minutesAgo* is when each started.
      const starts = [minutesAgo]
        .flat()
        .map((m) => new Date(Date.now() - m * 60_000).toISOString());
      const run = (cmd) =>
        cmd[1] === "ps"
          ? { status: 0, stdout: starts.map((_, i) => `id${i}`).join("\n") }
          : { status: 0, stdout: starts.map((s) => `auto\t${ws}\t${s}\t0\t0`).join("\n") };
      return runningLeases(run)[0].rank;
    };
    assert.equal(rank("done", 1), "working");
    assert.equal(rank("needs-you", 1), "working");
    assert.equal(rank("done", 6), "idle");
    assert.equal(rank("needs-you", 6), "human-check");
    // A container Docker restarted a minute ago (restart: unless-stopped) doesn't renew the hold.
    assert.equal(rank("done", [60, 1]), "idle");
  });
});

// SW-988: enqueue() stores a preempted waiter's position at enqueue time, and nothing rewrites it.
test("a waiter's position is its place in the queue now, as budget status counts it (SW-988)", async () => {
  await withHome(async (home) => {
    const ws = {};
    for (const f of ["a", "b", "c"])
      ws[f] = await queueWorkspace(f, { root: path.join(home, "features") });
    // enqueue puts each first (SW-1039): queued c, b, a reads a, b, c.
    for (const f of ["c", "b", "a"]) await enqueue(f, ws[f]);
    assert.equal(fs.readFileSync(waitingPath(ws.c), "utf8").includes('"position":1'), true);
    const roomy = { memory: 64 * G, cpus: 64, preempt: true };
    assert.deepEqual(await requestAdmission("a", ws.a, false, [], roomy), { kind: "admit" });
    assert.deepEqual([readWaiting(ws.b).position, readWaiting(ws.c).position], [1, 2]);
    // A gate waiter goes first, as queueOrder has it.
    writeWaiting(ws.c, { ...readWaiting(ws.c), gate: true });
    assert.deepEqual([readWaiting(ws.b).position, readWaiting(ws.c).position], [2, 1]);
    // Not queued: the stored number stands.
    await dequeue("b");
    assert.equal(readWaiting(ws.b).position, 1);
  });
});

// SW-998: a gate's heartbeat marker (SW-745) makes its feature busy, so not even a person's start preempts it.
test("preemption: a feature whose gate touched its exec marker just now is never a victim (SW-998)", async () => {
  await withHome(async (home) => {
    const ws = path.join(home, "features", "auto");
    fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "autonomous: true\n");
    const run = (cmd) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\n" }
        : { status: 0, stdout: `auto\t${ws}\t2026-10-29T10:00:00Z\t${G}\t4000000000\t0` };
    const budget = { memory: 8 * G, cpus: 6, preempt: true };
    const req = { feature: "other", cost: { memory: G, cpus: 4 }, byPerson: true };
    assert.equal(admit(budget, runningLeases(run), [], req).kind, "preempt");
    fs.writeFileSync(path.join(ws, ".werkmeister", "last-exec"), "");
    assert.equal(runningLeases(run)[0].busy, true);
    assert.deepEqual(admit(budget, runningLeases(run), [], req), { kind: "wait", position: 1 });
  });
});

// SW-1039: a preempted feature went to the back of the queue, behind every start queued after it was admitted.
test("enqueue: a preempted feature keeps its place ahead of later waiters (SW-1039)", async () => {
  await withHome(async (home) => {
    const ws = workspace(home, COMPOSE);
    await enqueue("later", ws);
    await enqueue("victim", ws);
    assert.deepEqual(readQueue(), ["victim", "later"]);
    assert.equal(readWaiting(ws).reason, "preempted");
    // The queue lands in the test's sandbox home, never the real ~/.werkmeister.
    const sandbox = path.dirname(process.env.WERKMEISTER_CONFIG_FILE);
    assert.ok(queuePath().startsWith(`${sandbox}/`), queuePath());
  });
});

// SW-1028: the budget tool ran a `docker run` per call (one per pane poll) only to learn the VM's cores.
// SW-1236: it now reads the VM's load too, still at most once a minute.
test("hostLoads: two reads within a minute run docker once (SW-1028, SW-1236)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-cores-"));
  const calls = path.join(dir, "calls");
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> "${calls}"\nprintf '0.5 0.4 0.3 1/100 1\\n6\\n'\n`, {
    mode: 0o755,
  });
  const prev = process.env.WERKMEISTER_DOCKER_BIN;
  process.env.WERKMEISTER_DOCKER_BIN = bin;
  try {
    const { hostLoads } = await import("../dist/budget_status.js");
    for (let i = 0; i < 2; i++) {
      const { vm } = await hostLoads("darwin");
      assert.equal(vm.load, 0.5);
      assert.equal(vm.limit, hostLoadLimit(6));
    }
    assert.equal(fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length, 1);
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_BIN;
    else process.env.WERKMEISTER_DOCKER_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
