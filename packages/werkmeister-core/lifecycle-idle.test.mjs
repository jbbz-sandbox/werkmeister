// The idle reaper (SW-39): `werkmeister internal reap <minutes>` and the `watchPrs` pass.
// Docker is stubbed, sessions come from temp workspaces; no ~/.claude, no real daemon.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { idleFeatures, idleStopMinutes, liveSessions, stopIdle } from "./dist/lifecycle.js";

process.env.WERKMEISTER_CONFIG_FILE = "/nonexistent/config.yaml";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;
const WS = "/ws/demo";

/** A temp workspace whose hooks recorded *sessions* (SW-182). */
function workspaceWith(sessions) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "idle-ws-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "agent-state.json"), JSON.stringify({ sessions }));
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
    { sessionId: "a", status: "idle", statusUpdatedAt: NOW - 5 * MIN },
    { sessionId: "b", status: "busy", statusUpdatedAt: NOW - 23 * 60 * MIN },
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
