// The idle reaper (SW-39): `werkmeister internal reap <minutes>` and the `watchPrs` pass.
// Docker is stubbed, sessions come from temp workspaces; no ~/.claude, no real daemon.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  idleFeatures,
  idleStopFeature,
  idleStopMinutes,
  liveSessions,
  stalledAfterMs,
  stopIdle,
} from "../dist/lifecycle.js";
import { writeSessions } from "./fixtures.mjs";

process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;
const WS = "/ws/demo";

/** A temp workspace whose hooks recorded *sessions* (SW-182). */
function workspaceWith(sessions) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "idle-ws-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  writeSessions(ws, sessions);
  return ws;
}

const input = (over = {}) => ({
  minutes: 30,
  now: NOW,
  running: [{ feature: "demo", workspace: WS, startedAt: [NOW - 60 * MIN] }],
  sessions: () => [],
  lastExec: () => null,
  ...over,
});

test("idleFeatures: idle only when containers, sessions and the gate are all quiet for N min", () => {
  assert.deepEqual(idleFeatures(input()), ["demo"]);
  const keptBy = {
    "busy session": { sessions: () => [{ status: "busy", statusUpdatedAt: NOW - 90 * MIN }] },
    "recently idle session": {
      sessions: () => [{ status: "idle", statusUpdatedAt: NOW - 5 * MIN }],
    },
    "session with no status": { sessions: () => [{ status: null, statusUpdatedAt: null }] },
    "fresh container": {
      running: [{ feature: "demo", workspace: WS, startedAt: [NOW - 60 * MIN, NOW - MIN] }],
    },
    "recent gate exec": { lastExec: () => NOW - 10 * MIN },
  };
  for (const [why, over] of Object.entries(keptBy))
    assert.deepEqual(idleFeatures(input(over)), [], why);
});

test("idleFeatures: an open session idle past the cutoff does not block (D3), and infra is never idle", () => {
  const open = { sessions: () => [{ status: "idle", statusUpdatedAt: NOW - 45 * MIN }] };
  assert.deepEqual(idleFeatures(input(open)), ["demo"]);
  const infra = { running: [{ feature: "infra", workspace: WS, startedAt: [NOW - 90 * MIN] }] };
  assert.deepEqual(idleFeatures(input(infra)), []);
});

test("liveSessions: the hooks' record with each status; a day-old record and junk dropped", () => {
  const at = (ms) => new Date(ms).toISOString();
  const ws = workspaceWith({
    a: { status: "idle", at: at(NOW - 5 * MIN) },
    b: { status: "busy", at: at(NOW - 23 * 60 * MIN) },
    crashed: { status: "busy", at: at(NOW - 25 * 60 * MIN) },
    junk: { status: "asleep", at: at(NOW) },
  });
  assert.deepEqual(liveSessions(ws, NOW), [
    { sessionId: "a", status: "idle", statusUpdatedAt: NOW - 5 * MIN, asking: false },
    { sessionId: "b", status: "busy", statusUpdatedAt: NOW - 23 * 60 * MIN, asking: false },
  ]);
  assert.deepEqual(liveSessions("/nonexistent/ws", NOW), []);
});

/** A docker stub: `ps -q` lists the ids, `inspect` prints one tab line per container. */
function docker(rows) {
  return (cmd) => {
    if (cmd[1] === "ps")
      return { status: 0, stdout: rows.map((_, i) => `id${i}`).join("\n"), stderr: "" };
    if (cmd[1] === "inspect")
      return { status: 0, stdout: rows.map((r) => r.join("\t")).join("\n"), stderr: "" };
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
}

test("stopIdle: stops the idle feature, keeps the active one, one line each; only limits it", async () => {
  const busyWs = workspaceWith({
    s1: { status: "busy", at: new Date(NOW - 60 * MIN).toISOString() },
  });
  const run = docker([
    ["demo", WS, new Date(NOW - 60 * MIN).toISOString()],
    ["demo", WS, new Date(NOW - 50 * MIN).toISOString()],
    ["busy", busyWs, new Date(NOW - 60 * MIN).toISOString()],
  ]);
  const stopped = [];
  const stop = async (f) => stopped.push(f);
  const r = await stopIdle(30, { now: NOW, run, stop });
  assert.deepEqual(r, {
    ok: true,
    lines: ["demo: stopped (idle ≥ 30 min)", "busy: kept (session active)"],
  });
  assert.deepEqual(stopped, ["demo"]);

  const only = await stopIdle(30, { now: NOW, run, stop, only: "busy" });
  assert.deepEqual(only.lines, ["busy: kept (session active)"]);
});

test("stopIdle: a recent gate exec marker keeps the feature", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gate-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "last-exec"), "");
  const run = docker([["demo", ws, new Date(Date.now() - 60 * MIN).toISOString()]]);
  const r = await stopIdle(30, {
    run,
    stop: async () => assert.fail(),
  });
  assert.deepEqual(r.lines, ["demo: kept (gate ran < 30 min ago)"]);
});

test("stopIdle: a failed stop is reported and not ok; no containers and no docker are ok", async () => {
  const run = docker([["demo", WS, new Date(NOW - 60 * MIN).toISOString()]]);
  const failed = await stopIdle(30, {
    now: NOW,
    run,
    stop: async () => {
      throw new Error("compose said no");
    },
  });
  assert.deepEqual(failed, { ok: false, lines: ["demo: stop failed — compose said no"] });

  assert.deepEqual(await stopIdle(30, { run: docker([]) }), {
    ok: true,
    lines: ["no running feature containers"],
  });
  const noDocker = () => ({ status: 1, stdout: "", stderr: "Cannot connect" });
  assert.deepEqual(await stopIdle(30, { run: noDocker }), {
    ok: true,
    lines: ["docker unavailable — nothing reaped"],
  });
});

test("stopIdle: finds containers under either label set (SW-93), inspecting each once", async () => {
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "ps") {
      const stdout = {
        "label=com.werkmeister.feature": "new\nboth",
        "label=com.sandbox.local.feature": "old\nboth",
      }[cmd[4]];
      return { status: 0, stdout, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  await stopIdle(30, { now: NOW, run, stop: async () => {} });
  const inspect = calls.find((c) => c[1] === "inspect");
  assert.deepEqual(inspect.slice(4), ["new", "both", "old"]);
  assert.match(
    inspect[3],
    /or \(index \.Config\.Labels "com\.werkmeister\.feature"\) \(index \.Config\.Labels "com\.sandbox\.local\.feature"\)/,
  );
});

test("idleStopMinutes: 30 by default, overrides.idle_stop_minutes when a whole number ≥ 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-config-"));
  const prev = process.env.WERKMEISTER_CONFIG_FILE;
  try {
    assert.equal(idleStopMinutes(), 30);
    process.env.WERKMEISTER_CONFIG_FILE = path.join(dir, "config.yaml");
    for (const [yml, want] of [
      ["overrides:\n  idle_stop_minutes: 15\n", 15],
      ["overrides:\n  idle_stop_minutes: 0\n", 0],
      ["overrides:\n  idle_stop_minutes: -1\n", 30],
      ["overrides:\n  idle_stop_minutes: soon\n", 30],
    ]) {
      fs.writeFileSync(process.env.WERKMEISTER_CONFIG_FILE, yml);
      assert.equal(idleStopMinutes(), want, yml);
    }
  } finally {
    process.env.WERKMEISTER_CONFIG_FILE = prev;
  }
});

// T7. SW-675: AskUserQuestion keeps the session `busy`, so a container at 0% CPU whose session waits
// on a person was never reaped. It is now, past the cutoff, but only while someone waits for room.
test("stopIdle: a session waiting on a person past the cutoff is reaped only while others queue", async () => {
  const asked = new Date(NOW - 60 * MIN).toISOString();
  const ws = workspaceWith({
    s1: { status: "busy", at: asked, ask: { kind: "question", what: "Approve?", at: asked } },
  });
  const run = docker([["never-fits", ws, new Date(NOW - 120 * MIN).toISOString()]]);
  const stopped = [];
  const stop = async (f) => stopped.push(f);
  const queued = await stopIdle(10, { now: NOW, run, stop, queued: true });
  assert.deepEqual(queued.lines, [
    "never-fits: stopped (waiting on a person ≥ 10 min, others queued)",
  ]);
  assert.deepEqual(stopped, ["never-fits"]);
  const alone = await stopIdle(10, {
    now: NOW,
    run,
    stop: async () => assert.fail(),
    queued: false,
  });
  assert.deepEqual(alone.lines, ["never-fits: kept (session active)"]);
  // A question asked within the cutoff keeps it even with a queue.
  const fresh = new Date(NOW - 5 * MIN).toISOString();
  const recent = workspaceWith({
    s1: { status: "busy", at: fresh, ask: { kind: "question", what: "Approve?", at: fresh } },
  });
  const r = await stopIdle(10, {
    now: NOW,
    run: docker([["never-fits", recent, new Date(NOW - 120 * MIN).toISOString()]]),
    stop: async () => assert.fail(),
    queued: true,
  });
  assert.deepEqual(r.lines, ["never-fits: kept (session active)"]);
});

// SW-919: a tool-permission prompt is mid-turn, often on a `docker exec` into this feature (SW-910).
// The reaper stopped it as "waiting on a person", and the approved command found no container.
test("stopIdle: a permission prompt past the cutoff keeps its containers while others queue (SW-919)", async () => {
  const asked = new Date(NOW - 60 * MIN).toISOString();
  const ws = workspaceWith({
    s1: { status: "busy", at: asked, ask: { kind: "permission", what: "Bash", at: asked } },
  });
  const r = await stopIdle(10, {
    now: NOW,
    run: docker([["prompted", ws, new Date(NOW - 120 * MIN).toISOString()]]),
    stop: async () => assert.fail("a permission prompt is mid-turn"),
    queued: true,
  });
  assert.deepEqual(r.lines, ["prompted: kept (session active)"]);
  assert.deepEqual(liveSessions(ws, NOW)[0].asking, false);
});

// SW-856, SW-702: the reaper stopped a container mid `docker exec` when the session's record read idle
// (a turn ended over a background run, idle_stop_minutes: 10). A running exec keeps the feature.
test("idleFeatures: a docker exec in flight keeps the feature (SW-856)", () => {
  const busy = {
    running: [{ feature: "demo", workspace: WS, startedAt: [NOW - 60 * MIN], execs: 1 }],
  };
  assert.deepEqual(idleFeatures(input(busy)), []);
});

test("stalledAfterMs: 30/30/90 min by default, overrides.stalled_*_minutes when a whole number ≥ 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stalled-config-"));
  const prev = process.env.WERKMEISTER_CONFIG_FILE;
  const M = 60_000;
  try {
    assert.deepEqual(stalledAfterMs(), { idleMs: 30 * M, waitMs: 30 * M, toolMs: 90 * M });
    process.env.WERKMEISTER_CONFIG_FILE = path.join(dir, "config.yaml");
    for (const [yml, want] of [
      [
        "overrides:\n  stalled_idle_minutes: 10\n  stalled_wait_minutes: 5\n  stalled_tool_minutes: 45\n",
        [10, 5, 45],
      ],
      [
        "overrides:\n  stalled_idle_minutes: 0\n  stalled_wait_minutes: -1\n  stalled_tool_minutes: 0\n",
        [30, 30, 90],
      ],
      ["overrides:\n  stalled_idle_minutes: soon\n  stalled_tool_minutes: 1.5\n", [30, 30, 90]],
    ]) {
      fs.writeFileSync(process.env.WERKMEISTER_CONFIG_FILE, yml);
      const [idle, wait, tool] = want;
      assert.deepEqual(
        stalledAfterMs(),
        { idleMs: idle * M, waitMs: wait * M, toolMs: tool * M },
        yml,
      );
    }
  } finally {
    process.env.WERKMEISTER_CONFIG_FILE = prev;
  }
});

// SW-1024: a grant writes its "continue" to resume-nudge.json; an idle session never read it, and
// the reaper stopped the granted containers before the session had run anything.
test("stopIdle: a granted start whose continue is undelivered keeps its containers while a session is open (SW-1024)", async () => {
  const ws = workspaceWith({ s1: { status: "idle", at: new Date(NOW - 60 * MIN).toISOString() } });
  const nudge = path.join(ws, ".werkmeister", "resume-nudge.json");
  // Left 5 min ago by a grant whose containers came up before the cutoff (a parked service, a Resume).
  const leftAgo = (ms) => {
    fs.writeFileSync(nudge, JSON.stringify({ message: "Capacity freed" }));
    fs.utimesSync(nudge, (NOW - ms) / 1000, (NOW - ms) / 1000);
  };
  leftAgo(5 * MIN);
  const run = docker([["granted", ws, new Date(NOW - 45 * MIN).toISOString()]]);
  const r = await stopIdle(10, { now: NOW, run, stop: async () => assert.fail("reaped") });
  assert.deepEqual(r.lines, ["granted: kept (continue not yet delivered)"]);
  // Left past the cutoff and still not taken (session asking, closed, no mod): the hold ends.
  leftAgo(45 * MIN);
  const late = [];
  await stopIdle(10, { now: NOW, run, stop: async (f) => late.push(f) });
  assert.deepEqual(late, ["granted"]);
  // Delivered (the claim removes the file): the idle clock runs again.
  fs.rmSync(nudge);
  const stopped = [];
  await stopIdle(10, { now: NOW, run, stop: async (f) => stopped.push(f) });
  assert.deepEqual(stopped, ["granted"]);
  // No open session to deliver to: nothing to wait for.
  const closed = workspaceWith({});
  fs.writeFileSync(path.join(closed, ".werkmeister", "resume-nudge.json"), '{"message":"x"}');
  const gone = [];
  await stopIdle(10, {
    now: NOW,
    run: docker([["closed", closed, new Date(NOW - 45 * MIN).toISOString()]]),
    stop: async (f) => gone.push(f),
  });
  assert.deepEqual(gone, ["closed"]);
});

// SW-1033: the SessionEnd auto-stop reached a plain stop(), which drops a queued start (SW-1017).
test("idleStopFeature: a workspace waiting for capacity as a whole is not auto-stopped (SW-1033)", () => {
  const ws = workspaceWith({});
  const at = {
    feature: "demo",
    workspaceRoot: ws,
    sessionId: "s1",
    reason: "other",
    entrypoint: "cli",
  };
  assert.equal(idleStopFeature(at), "demo");
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "waiting.json"),
    JSON.stringify({ position: 1, reason: "preempted" }),
  );
  assert.equal(idleStopFeature(at), null);
  // A service start's wait runs beside running containers: those still stop.
  fs.writeFileSync(
    path.join(ws, ".werkmeister", "waiting.json"),
    JSON.stringify({ position: 1, reason: "waiting for capacity", services: ["api"] }),
  );
  assert.equal(idleStopFeature(at), "demo");
  // A left-over whole-feature waiting.json (its feature out of the queue) does not hold the stop.
  const waiting = path.join(ws, ".werkmeister", "waiting.json");
  fs.writeFileSync(waiting, JSON.stringify({ position: 1, reason: "preempted" }));
  fs.writeFileSync(path.join(ws, ".env"), "FEATURE=demo\n");
  const old = (Date.now() - MIN) / 1000;
  fs.utimesSync(waiting, old, old);
  assert.equal(idleStopFeature(at), "demo");
});
