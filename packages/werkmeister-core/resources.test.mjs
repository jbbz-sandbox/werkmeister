// SW-41: the vitals core adds to the status contract — crash loops, start
// reason and per-project CPU/memory — as pure functions over Engine data.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "resources-home-"));
const root = path.join(home, "features");
process.env.HOME = home;
process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";
process.env.WERKMEISTER_WORKSPACES_ROOT = root;
// No daemon: every Engine call fails fast, so status reads take their "unreachable" path.
process.env.DOCKER_HOST = `unix://${path.join(home, "no-daemon.sock")}`;

const {
  CRASH_WINDOW_MS,
  healthOf,
  hostSummary,
  isCrashLoop,
  readStarts,
  recordStart,
  startedBy,
  startsFile,
  usageByProject,
  withStartRecord,
} = await import("./dist/resources.js");
const { getWorkspaceStatuses } = await import("./dist/sandbox.js");

const NOW = Date.parse("2026-10-20T12:00:00Z");
const rt = (startedAt, restartCount = 0) => ({ startedAt, restartCount, tty: false });
const iso = (ms) => new Date(ms).toISOString();

test("isCrashLoop: restarting, recent policy restarts, and a capped policy that gave up", () => {
  assert.equal(isCrashLoop({ state: "restarting" }, undefined, NOW), true);
  assert.equal(isCrashLoop({ state: "running" }, rt(NOW - 10_000, 3), NOW), true);
  assert.equal(
    isCrashLoop({ state: "running" }, rt(NOW - CRASH_WINDOW_MS - 1, 1), NOW),
    false,
    "one crash long ago on a container that has run since is history",
  );
  assert.equal(isCrashLoop({ state: "exited" }, rt(NOW - 3_600_000, 3), NOW), true);
  assert.equal(isCrashLoop({ state: "running" }, rt(NOW - 10_000, 0), NOW), false);
  assert.equal(isCrashLoop({ state: "running" }, undefined, NOW), false);
});

test("startedBy: the newest window that holds the start, with clock slack; else person", () => {
  const starts = [
    { by: "up", from: iso(NOW - 600_000), to: iso(NOW - 500_000) },
    { by: "gate", from: iso(NOW - 550_000), to: iso(NOW - 540_000) },
  ];
  assert.equal(startedBy(NOW - 545_000, starts), "gate", "overlap: newest record wins");
  assert.equal(startedBy(NOW - 520_000, starts), "up");
  assert.equal(startedBy(NOW - 499_000, starts), "up", "1 s past `to` is inside the slack");
  assert.equal(startedBy(NOW - 400_000, starts), "person");
  assert.equal(startedBy(NOW, []), "person");
});

test("recordStart / readStarts: appends, keeps the last 10, never throws", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "starts-"));
  assert.deepEqual(readStarts(ws), []);
  for (let i = 0; i < 12; i++) recordStart(ws, i % 2 ? "gate" : "up", NOW + i, NOW + i + 1);
  const list = readStarts(ws);
  assert.equal(list.length, 10);
  assert.equal(list[0].from, iso(NOW + 2));
  assert.equal(list[9].by, "gate");
  assert.equal(startsFile(ws), path.join(ws, ".werkmeister", "starts.json"));
  fs.writeFileSync(startsFile(ws), "{ not json");
  assert.deepEqual(readStarts(ws), []);
});

test("withStartRecord: records on success and when the work throws", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "starts-"));
  assert.equal(await withStartRecord(ws, "up", async () => true), true);
  await assert.rejects(
    withStartRecord(ws, "restart", async () => {
      throw new Error("compose failed");
    }),
  );
  assert.deepEqual(
    readStarts(ws).map((s) => s.by),
    ["up", "restart"],
  );
});

test("healthOf: earliest running start and its reason, crash loops per service", () => {
  const c = (name, project, service, state, exitCode = 0) => ({
    name,
    state,
    health: "",
    ports: "",
    service,
    exitCode,
    labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.project.working_dir": `/ws/${project}`,
    },
  });
  const containers = [
    c("a-web", "sandbox-a", "web", "running"),
    c("a-api", "sandbox-a", "api", "running"),
    c("a-worker", "sandbox-a", "worker", "restarting"),
    c("b-cli", "sandbox-b", "cli", "running"),
    c("b-gone", "sandbox-b", "gone", "running"),
  ];
  const runtime = new Map([
    ["a-web", rt(NOW - 7_200_000)],
    ["a-api", rt(NOW - 30_000, 4)],
    ["a-worker", rt(NOW - 5_000, 9)],
    ["b-cli", rt(NOW - 60_000)],
    // b-gone: inspect failed, so it neither starts nor loops anything
  ]);
  const starts = {
    "/ws/sandbox-a": [{ by: "up", from: iso(NOW - 7_201_000), to: iso(NOW - 7_100_000) }],
    "/ws/sandbox-b": [],
  };
  const h = healthOf(containers, runtime, (dir) => starts[dir], NOW);
  assert.deepEqual(h.get("sandbox-a"), {
    started: { at: iso(NOW - 7_200_000), by: "up" },
    crashLoops: [
      { service: "api", restarts: 4, lastLog: null },
      { service: "worker", restarts: 9, lastLog: null },
    ],
  });
  assert.deepEqual(h.get("sandbox-b"), {
    started: { at: iso(NOW - 60_000), by: "person" },
    crashLoops: [],
  });
});

test("usageByProject / hostSummary: one sweep summed per project; infra is not a feature", () => {
  const s = (project, feature, cpuPercent, memMib, prefix = "com.sandbox.local") => ({
    name: `${project}-x`,
    cpuPercent,
    memMib,
    memLimitMib: 0,
    labels: {
      "com.docker.compose.project": project,
      ...(feature ? { [`${prefix}.feature`]: feature } : {}),
    },
  });
  const stats = [
    s("sandbox-a", "a", 12.34, 100.4),
    s("sandbox-a", "a", 0.02, 300.3),
    s("sandbox-infra", "infra", 50, 64),
    s("other", null, 7, 1),
    s("werkmeister-b", "b", 1, 10, "com.werkmeister"),
  ];
  assert.deepEqual(usageByProject(stats), {
    "sandbox-a": { cpuPercent: 12.4, memMib: 401 },
    "sandbox-infra": { cpuPercent: 50, memMib: 64 },
    other: { cpuPercent: 7, memMib: 1 },
    "werkmeister-b": { cpuPercent: 1, memMib: 10 },
  });
  assert.deepEqual(hostSummary(stats, [3.21, 2.86, 2.04], 10), {
    load: [3.2, 2.9, 2],
    cores: 10,
    featureCpuPercent: 13.4,
  });
});

test("getWorkspaceStatuses: docker unreachable → no start, no crash loops", async () => {
  fs.mkdirSync(path.join(root, "ws-a", ".werkmeister"), { recursive: true });
  const { statuses } = await getWorkspaceStatuses();
  const a = statuses.find((s) => s.name === "ws-a");
  assert.equal(a.state, "unknown");
  assert.equal(a.started, null);
  assert.deepEqual(a.crashLoops, []);
});
