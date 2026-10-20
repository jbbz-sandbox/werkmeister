// The idle reaper (SW-39): `werkmeister stop --idle <minutes>` and the `watchPrs` pass.
// Docker and the sessions dir are stubbed; nothing here reads ~/.claude or a real daemon.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { idleFeatures, idleStopMinutes, liveSessions, stopIdle } from "./dist/lifecycle.js";

process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;
const WS = "/ws/demo";

function sessionsDir(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-sessions-"));
  for (const [i, e] of entries.entries())
    fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(e));
  return dir;
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

test("liveSessions: live sessions in the workspace with their status; dead pids, other folders and prefixes dropped", () => {
  const live = process.pid;
  const dir = sessionsDir([
    {
      pid: live,
      sessionId: "a",
      cwd: path.join(WS, "sandbox"),
      status: "idle",
      statusUpdatedAt: 5,
    },
    { pid: 2 ** 22 + 7, sessionId: "dead", cwd: WS, status: "busy" },
    { pid: live, sessionId: "other", cwd: "/ws/other", status: "busy" },
    { pid: live, sessionId: "prefix", cwd: "/ws/demo-2", status: "busy" },
  ]);
  assert.deepEqual(liveSessions(WS, dir), [
    { pid: live, sessionId: "a", status: "idle", statusUpdatedAt: 5 },
  ]);
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
  const busyWs = fs.mkdtempSync(path.join(os.tmpdir(), "idle-busy-"));
  const run = docker([
    ["demo", WS, new Date(NOW - 60 * MIN).toISOString()],
    ["demo", WS, new Date(NOW - 50 * MIN).toISOString()],
    ["busy", busyWs, new Date(NOW - 60 * MIN).toISOString()],
  ]);
  const sessions = sessionsDir([{ pid: process.pid, cwd: busyWs, status: "busy" }]);
  const stopped = [];
  const stop = async (f) => stopped.push(f);
  const r = await stopIdle(30, { now: NOW, run, sessionsDir: sessions, stop });
  assert.deepEqual(r, {
    ok: true,
    lines: ["demo: stopped (idle ≥ 30 min)", "busy: kept (session active)"],
  });
  assert.deepEqual(stopped, ["demo"]);

  const only = await stopIdle(30, { now: NOW, run, sessionsDir: sessions, stop, only: "busy" });
  assert.deepEqual(only.lines, ["busy: kept (session active)"]);
});

test("stopIdle: a recent gate exec marker keeps the feature", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gate-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "last-exec"), "");
  const run = docker([["demo", ws, new Date(Date.now() - 60 * MIN).toISOString()]]);
  const r = await stopIdle(30, {
    run,
    sessionsDir: sessionsDir([]),
    stop: async () => assert.fail(),
  });
  assert.deepEqual(r.lines, ["demo: kept (gate ran < 30 min ago)"]);
});

test("stopIdle: a failed stop is reported and not ok; no containers and no docker are ok", async () => {
  const run = docker([["demo", WS, new Date(NOW - 60 * MIN).toISOString()]]);
  const failed = await stopIdle(30, {
    now: NOW,
    run,
    sessionsDir: sessionsDir([]),
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

test("idleStopMinutes: 30 by default, overrides.idle_stop_minutes when a whole number ≥ 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-config-"));
  const prev = process.env.SANDBOX_CONFIG_FILE;
  try {
    assert.equal(idleStopMinutes(), 30);
    process.env.SANDBOX_CONFIG_FILE = path.join(dir, "config.yaml");
    for (const [yml, want] of [
      ["overrides:\n  idle_stop_minutes: 15\n", 15],
      ["overrides:\n  idle_stop_minutes: 0\n", 0],
      ["overrides:\n  idle_stop_minutes: -1\n", 30],
      ["overrides:\n  idle_stop_minutes: soon\n", 30],
    ]) {
      fs.writeFileSync(process.env.SANDBOX_CONFIG_FILE, yml);
      assert.equal(idleStopMinutes(), want, yml);
    }
  } finally {
    process.env.SANDBOX_CONFIG_FILE = prev;
  }
});
