// SW-70: Pause freezes a workspace's running containers and holds its session;
// Resume brings back exactly those and tells the session to continue. A fake
// Engine on a unix socket stands in for the daemon, a `docker` stub for the CLI
// lookups and a `claude` stub for claude-send: nothing touches a real container.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { useDockerEngine, writeSessionState } from "./fixtures.mjs";

useDockerEngine();

const dir = fs.mkdtempSync(path.join(tmpdir(), "sandbox-pause-"));
const sock = path.join(dir, "docker.sock");
const root = path.join(dir, "features");
const ws = path.join(root, "demo-ws");
const dot = path.join(ws, ".werkmeister");
fs.mkdirSync(dot, { recursive: true });
fs.writeFileSync(path.join(dot, "workspace.yml"), "feature: demo\n");
fs.writeFileSync(path.join(ws, "compose.yml"), "services: {}\n");
fs.writeFileSync(path.join(ws, ".env"), "FEATURE=demo\n");
const home = path.join(dir, "home");
fs.mkdirSync(path.join(home, ".werkmeister"), { recursive: true });
const config = path.join(home, ".werkmeister", "config.yaml");
fs.writeFileSync(config, `version: 1\npaths:\n  workspaces_root: ${root}\n`);
fs.writeFileSync(path.join(home, ".werkmeister", "services.yaml"), "services: {}\n");
fs.writeFileSync(
  path.join(home, ".werkmeister", "ports.yaml"),
  "feature_slots:\n  count: 12\n  base_port: 11100\n  ports_per_slot: 20\n",
);
// The compose-label lookup shells out to `docker ps`; this one names the workspace.
const bin = path.join(dir, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "docker"),
  `#!/bin/sh\nsleep "\${DOCKER_DELAY:-0}"\necho "${ws}"\n`,
  { mode: 0o755 },
);
const claudeLog = path.join(dir, "claude.log");
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${claudeLog}"\n`, {
  mode: 0o755,
});

const LABELS = {
  "com.docker.compose.project": "sandbox-demo",
  "com.sandbox.local.feature": "demo",
  "com.sandbox.local.slot": "3",
};
let containers;
const reset = () => {
  containers = {
    "demo-db": { service: "db", state: "running" },
    "demo-api": { service: "api", state: "running", deps: "db:service_started:false" },
    "demo-install": { service: "install", state: "running", role: "setup" },
    "demo-web": { service: "web", state: "exited" },
    "demo-manual": { service: "manual", state: "paused" },
  };
};
let calls = [];
let markerAtCall = [];
let reply = {};
const pausedFile = path.join(dot, "paused.json");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://engine");
  res.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/containers/json")) {
    const all = url.searchParams.get("all") === "true";
    const list = Object.entries(containers)
      .filter(([, c]) => all || c.state !== "exited")
      .map(([name, c]) => ({
        Id: `${name}-id`,
        Names: [`/${name}`],
        State: c.state,
        Status: c.state === "exited" ? "Exited (0) 1 hour ago" : "Up 1 hour",
        Ports: [],
        Labels: {
          ...LABELS,
          "com.docker.compose.service": c.service,
          ...(c.deps ? { "com.docker.compose.depends_on": c.deps } : {}),
          ...(c.role ? { "com.sandbox.local.role": c.role } : {}),
        },
      }));
    res.end(JSON.stringify(list));
    return;
  }
  const m = /\/containers\/([^/]+)\/(json|pause|unpause|start)$/.exec(url.pathname);
  const c = m && containers[m[1]];
  if (!c) {
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "No such container" }));
    return;
  }
  const [, name, action] = m;
  if (action === "json") {
    res.end(
      JSON.stringify({
        State: { Running: c.state !== "exited", Paused: c.state === "paused" },
      }),
    );
    return;
  }
  calls.push(`${action} ${name}`);
  markerAtCall.push(fs.existsSync(pausedFile));
  const code = reply[name];
  if (code) {
    res.statusCode = code;
    res.end(JSON.stringify({ message: code === 409 ? "already paused" : "cgroup freeze failed" }));
    return;
  }
  c.state = action === "pause" ? "paused" : "running";
  res.statusCode = 204;
  res.end();
});
// The Engine shares this process's loop: a slow docker stub blocks it past the 5 s
// keep-alive default, and the next test's request would land on a closed socket (SW-299).
server.keepAliveTimeout = 0;
await new Promise((resolve) => server.listen(sock, resolve));
process.env.DOCKER_HOST = `unix://${sock}`;
process.env.HOME = home;
process.env.WERKMEISTER_CONFIG_FILE = config;
process.env.CLAUDE_BIN = path.join(bin, "claude");
process.env.PATH = `${bin}:${process.env.PATH}`;
process.chdir(ws);

const { down, pause, resume, restart, up } = await import("./dist/lifecycle.js");
const { claimResumeNudge, resumeAndNudge } = await import("./dist/sandbox.js");
const { readPaused, writePaused, RESUME_NUDGE } = await import("./dist/agent_state.js");

const nudgeFile = path.join(dot, "resume-nudge.json");
const readLog = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, "utf8") : "");

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  reset();
  calls = [];
  markerAtCall = [];
  reply = {};
  delete process.env.DOCKER_DELAY;
  delete process.env.WERKMEISTER_TIMEOUT_SCALE;
  for (const f of [
    pausedFile,
    nudgeFile,
    claudeLog,
    path.join(dot, "agent-state.json"),
    path.join(dot, "sessions"),
  ])
    fs.rmSync(f, { force: true, recursive: true });
});

test("pause freezes exactly the running containers, dependents first, after writing the record", async () => {
  writeSessionState(ws, "working");
  const r = await pause("demo");
  assert.deepEqual(r.containers, ["demo-db", "demo-api", "demo-install"]);
  assert.deepEqual(calls, ["pause demo-install", "pause demo-api", "pause demo-db"]);
  assert.ok(markerAtCall.every(Boolean), "the record exists before the first freeze");
  const rec = readPaused(ws);
  assert.deepEqual(rec.containers, ["demo-db", "demo-api", "demo-install"]);
  assert.equal(rec.was_working, true);
  // A workspace that predates SW-46 gets the hook that carries the gate.
  const settings = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"));
  assert.match(JSON.stringify(settings.hooks.PreToolUse), /werkmeister internal agent-state/);
});

// SW-681: a turn that ended with a background shell still running is working, so Resume tells it to continue.
test("pause records was_working for a stopped session whose background shell still runs", async () => {
  const at = new Date().toISOString();
  const stopped = { status: "idle", at, last: at, stopped: true };
  fs.mkdirSync(path.join(dot, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dot, "sessions", "s1.json"), JSON.stringify(stopped));
  await pause("demo");
  assert.equal(readPaused(ws).was_working, false, "a finished turn isn't working");
  fs.rmSync(pausedFile);
  const shell = { command: "werkmeister pr open", at, id: "b1" };
  fs.writeFileSync(path.join(dot, "sessions", "s1.json"), JSON.stringify({ ...stopped, shell }));
  await pause("demo");
  assert.equal(readPaused(ws).was_working, true);
});

test("pause refuses twice and a feature with no slot", async () => {
  await pause("demo");
  await assert.rejects(pause("demo"), { code: "ALREADY_PAUSED" });
  await assert.rejects(pause("nope"), { code: "NOT_RUNNING" });
});

// SW-299: a loaded host can make the label lookup's `docker ps` slow; that must not lose the workspace.
// Timeouts at 0.1 scale: the 300 s cap is 30 s and the old 10 s cap 1 s, so a 1.1 s stub still catches a return to it (SW-406).
test("a slow docker lookup still finds the workspace", async () => {
  process.env.DOCKER_DELAY = "1.1";
  process.env.WERKMEISTER_TIMEOUT_SCALE = "0.1";
  assert.deepEqual((await pause("demo")).containers, ["demo-db", "demo-api", "demo-install"]);
});

test("pause counts 409 as done; any other failure names it and keeps the record", async () => {
  reply = { "demo-db": 409 };
  await pause("demo");
  fs.rmSync(pausedFile);
  reset();
  reply = { "demo-api": 500 };
  await assert.rejects(pause("demo"), (e) => {
    assert.equal(e.code, "COMPOSE_PAUSE_FAILED");
    assert.match(e.message, /demo-api: cgroup freeze failed/);
    return true;
  });
  assert.deepEqual(calls.slice(-3), ["pause demo-install", "pause demo-api", "pause demo-db"]);
  assert.ok(readPaused(ws), "Resume can undo a partial pause");
});

test("resume unpauses, starts what was stopped meanwhile, skips a gone one, touches nothing else", async () => {
  await pause("demo");
  calls = [];
  markerAtCall = [];
  containers["demo-api"].state = "exited"; // the idle reaper, or ■ Stop
  delete containers["demo-db"];
  const r = await resume("demo");
  assert.deepEqual(r.containers, [
    { name: "demo-db", did: "missing" },
    { name: "demo-api", did: "started" },
    { name: "demo-install", did: "unpaused" },
  ]);
  assert.deepEqual(calls, ["start demo-api", "unpause demo-install"]);
  assert.equal(
    containers["demo-manual"].state,
    "paused",
    "paused by hand before Pause: left alone",
  );
  assert.ok(markerAtCall.every(Boolean), "the session stays held until the last container is back");
  assert.equal(readPaused(ws), null);
  await assert.rejects(resume("demo"), { code: "NOT_PAUSED" });
});

test("up and restart refuse while paused", async () => {
  await pause("demo");
  await assert.rejects(restart("demo"), { code: "PAUSED" });
  await assert.rejects(up("demo", ws), { code: "PAUSED" });
});

test("down ends a pause", async () => {
  await pause("demo");
  fs.writeFileSync(nudgeFile, "{}");
  await down("demo");
  assert.equal(readPaused(ws), null);
  assert.equal(fs.existsSync(nudgeFile), false);
});

const paused = (was_working) =>
  writePaused(ws, { at: new Date().toISOString(), containers: [], was_working });

test("resumeAndNudge: nothing to continue when Pause cut no turn", async () => {
  paused(false);
  assert.equal((await resumeAndNudge("demo-ws", ws, "demo")).nudge, "none");
  assert.equal(readLog(), "");
  assert.equal(fs.existsSync(nudgeFile), false);
});

test("resumeAndNudge: with no live session, continue goes headless", async () => {
  paused(true);
  assert.equal((await resumeAndNudge("demo-ws", ws, "demo")).nudge, "headless");
  // `claude` is spawned detached; give a slow first exec time to log (SW-67).
  for (const end = Date.now() + 30_000; !readLog() && Date.now() < end; ) await sleep(50);
  assert.match(readLog(), new RegExp(RESUME_NUDGE));
  assert.equal(fs.existsSync(nudgeFile), false);
});

// SW-397: the hooks' record can miss an open terminal session; a `claude` process in the
// workspace still means no headless `--resume` beside it.
// The gate's container has neither `ps` nor `lsof`; the host the CLI runs on has both.
const noProcTools = ["ps", "lsof"].some(
  (b) => spawnSync("sh", ["-c", `command -v ${b}`]).status !== 0,
);
// A process `ps` lists as *name*, its cwd in the workspace. Not a `/bin/sleep` symlink: Ubuntu
// 26.04's multi-call coreutils picks the tool by argv[0], so `claude -> sleep` exits at once.
const openProcess = (name) =>
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    argv0: name,
    cwd: path.join(ws, ".werkmeister"),
  });
test("resumeAndNudge: an open claude process with no record gets a pending nudge", {
  skip: noProcTools && "no ps/lsof",
}, async (t) => {
  paused(true);
  const child = openProcess("claude");
  t.after(() => child.kill());
  assert.equal((await resumeAndNudge("demo-ws", ws, "demo")).nudge, "pending");
  assert.equal(readLog(), "", "no second claude on a live transcript");
  assert.equal(await claimResumeNudge("demo-ws"), RESUME_NUDGE);
});

// SW-488: in a `harness: codex` workspace the open session is a `codex` process, not `claude`.
test("resumeAndNudge: an open codex process in a codex workspace gets a pending nudge", {
  skip: noProcTools && "no ps/lsof",
}, async (t) => {
  paused(true);
  const yml = path.join(dot, "workspace.yml");
  fs.writeFileSync(yml, "feature: demo\nharness: codex\n");
  t.after(() => fs.writeFileSync(yml, "feature: demo\n"));
  // A missed guard would run `codex exec resume`: never the real one.
  const prevBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = path.join(bin, "claude");
  t.after(() =>
    prevBin === undefined ? delete process.env.CODEX_BIN : (process.env.CODEX_BIN = prevBin),
  );
  const child = openProcess("codex");
  t.after(() => child.kill());
  assert.equal((await resumeAndNudge("demo-ws", ws, "demo")).nudge, "pending");
  assert.equal(readLog(), "", "no headless codex beside the open one");
  assert.equal(await claimResumeNudge("demo-ws"), RESUME_NUDGE);
});

test("resumeAndNudge: a live session gets a pending nudge, claimed once", async () => {
  paused(true);
  fs.writeFileSync(
    path.join(dot, "agent-state.json"),
    JSON.stringify({ sessions: { "s-1": { status: "idle", at: new Date().toISOString() } } }),
  );
  assert.equal((await resumeAndNudge("demo-ws", ws, "demo")).nudge, "pending");
  assert.equal(readLog(), "", "no second claude on a live transcript");
  assert.equal(await claimResumeNudge("demo-ws"), RESUME_NUDGE);
  assert.equal(await claimResumeNudge("demo-ws"), null);
});
