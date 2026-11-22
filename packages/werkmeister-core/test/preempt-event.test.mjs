// SW-989: preemption was pieced together from file times; each stopped victim is now one queue.preempt line.
// Its own file: the victim's slot is read over the Engine API, and the Docker client is cached per process.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { writeWaiting } from "../dist/agent_state.js";
import { loadPorts, loadServices } from "../dist/config.js";
import { generateFeatureCompose } from "../dist/generate.js";
import { grantWaiters, up } from "../dist/lifecycle.js";
import { metricsPath } from "../dist/metrics.js";
import { workspaceServices } from "../dist/registry_sync.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { writeLeases } from "../dist/scheduler_state.js";
import { pinWerkmeisterRoot, useDockerEngine, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();
useDockerEngine();

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js").default;
const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../docs/superpowers/specs/2026-11-15-metrics-events.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({
  formats: { "date-time": (s) => !Number.isNaN(Date.parse(s)), uri: (s) => URL.canParse(s) },
}).compile(schema);

// The Engine answers only the label query: the holder's one container, on slot 1.
const dir = fs.mkdtempSync(path.join(tmpdir(), "preempt-"));
const sock = path.join(dir, "docker.sock");
const engine = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (!new URL(req.url, "http://engine").pathname.endsWith("/containers/json")) {
    res.end("{}");
    return;
  }
  res.end(
    JSON.stringify([
      {
        Id: "holder-app-id",
        Names: ["/holder-app"],
        State: "running",
        Status: "Up 1 hour",
        Ports: [],
        Labels: {
          "com.werkmeister.feature": "holder",
          "com.werkmeister.slot": "1",
          "com.docker.compose.service": "app",
        },
      },
    ]),
  );
});
await new Promise((resolve) => engine.listen(sock, resolve));
after(() => {
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a preemption writes one queue.preempt: the victim, its rank and the feature it made room for", async () => {
  const holder = {
    feature: "holder",
    workspace: "holder",
    startedAt: "2026-11-16T00:00:00Z", // long past the hold
    memory: 2 ** 30,
    nanoCpus: 3e9,
  };
  await withFixtureWorkspace(
    async (fx) => {
      process.env.DOCKER_HOST = `unix://${sock}`; // before the first docker() call, which caches it
      const holderWs = path.join(fx.root, "ws", "holder");
      // Autonomous with no session record: it ranks idle.
      fs.mkdirSync(path.join(holderWs, ".werkmeister"), { recursive: true });
      fs.writeFileSync(path.join(holderWs, ".werkmeister", "workspace.yml"), "autonomous: true\n");
      writeLeases({ holder: { slot: 1, workspace: holderWs } });
      const ws = path.join(fx.root, "ws", "big");
      fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".env"), "FEATURE=big\nWERKMEISTER_SLOT=3\nSERVICES=big\n");
      const config = { services: workspaceServices(loadServices(), ws), ports: loadPorts() };
      generateFeatureCompose("big", 3, ["big"], config, ws, "werkmeister CLI");
      const rep = collectingReporter();
      const quiet = (fn) => withReporter(rep, fn);
      assert.equal((await quiet(() => up("big", ws, { byPerson: false }))).waiting, 1);
      // Starved: a head that has waited STARVE_MS may stop an idle lease.
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      writeWaiting(ws, { position: 1, reason: "waiting for capacity", since });
      await quiet(grantWaiters);
      const file = metricsPath(new Date().toISOString());
      const events = fs
        .readFileSync(file, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l));
      for (const e of events) assert.ok(validate(e), JSON.stringify(validate.errors));
      const preempts = events.filter((e) => e.event === "queue.preempt");
      assert.deepEqual(
        preempts.map(({ workspace, feature, rank, for: by }) => ({ workspace, feature, rank, by })),
        [{ workspace: "holder", feature: "holder", rank: "idle", by: "big" }],
        rep.text(),
      );
    },
    {
      containers: [holder],
      config: { budget: { cpus: 5, memory: "16G" } },
      services:
        "services:\n  big:\n    type: api\n    repo: app\n    port_offset: 2\n    cpus: 5\n",
    },
  );
});
