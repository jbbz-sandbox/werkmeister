// SW-70: Pause freezes a workspace's running containers and holds its session;
// Resume brings back exactly those and tells the session to continue. A fake
// Engine on a unix socket stands in for the daemon, a `docker` stub for the CLI
// lookups and a `claude` stub for claude-send: nothing touches a real container.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

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
fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "${ws}"\n`, { mode: 0o755 });
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
  for (const f of [pausedFile, nudgeFile, claudeLog, path.join(dot, "agent-state.json")])
    fs.rmSync(f, { force: true });
});

test("pause freezes exactly the running containers, dependents first, after writing the record", async () => {
  fs.writeFileSync(
    path.join(dot, "agent-state.json"),
    JSON.stringify({ state: "working", at: "2026-10-22T10:00:00.000Z" }),
  );
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

test("pause refuses twice and a feature with no slot", async () => {
  await pause("demo");
  await assert.rejects(pause("demo"), { code: "ALREADY_PAUSED" });
  await assert.rejects(pause("nope"), { code: "NOT_RUNNING" });
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
