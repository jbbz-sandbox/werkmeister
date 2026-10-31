// SW-60: stop/restart go container by container on the Engine API instead of
// `docker compose stop`/`restart`. A fake Engine on a unix socket pins the
// depends_on order, the setup skip and the error text, with no real daemon.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { useDockerEngine } from "./fixtures.mjs";

useDockerEngine();

const dir = mkdtempSync(path.join(tmpdir(), "sandbox-fake-engine-"));
const sock = path.join(dir, "docker.sock");
const composeFile = path.join(dir, "compose.yml");
writeFileSync(composeFile, "services:\n  ondemand:\n    profiles: [on-demand]\n");

const container = (name, service, state, labels = {}) => ({
  Id: `${name}-id`,
  Names: [`/${name}`],
  State: state,
  Status: state === "running" ? "Up 1 hour" : "Exited (0) 1 hour ago",
  Ports: [],
  Labels: {
    "com.docker.compose.project": "sandbox-demo",
    "com.docker.compose.service": service,
    "com.docker.compose.project.config_files": composeFile,
    ...labels,
  },
});

const FIXTURE = [
  container("demo-backend", "backend", "running", {
    "com.docker.compose.depends_on":
      "install:service_completed_successfully:false,cache:service_started:false",
  }),
  container("demo-cache", "cache", "running"),
  container("demo-frontend", "frontend", "exited", {
    "com.docker.compose.depends_on": "backend:service_started:false",
  }),
  container("demo-install", "install", "exited", { "com.sandbox.local.role": "setup" }),
  container("demo-ondemand", "ondemand", "exited"),
];
let calls = [];
let failing = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://engine");
  res.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/containers/json")) {
    const all = url.searchParams.get("all") === "true";
    res.end(JSON.stringify(FIXTURE.filter((c) => all || c.State === "running")));
    return;
  }
  const [, name, action] = /\/containers\/([^/]+)\/(stop|restart)$/.exec(url.pathname);
  calls.push(`${action} ${name}`);
  if (name === failing) {
    res.statusCode = 500;
    res.end(JSON.stringify({ message: "driver failed programming external connectivity" }));
    return;
  }
  res.statusCode = 204;
  res.end();
});
await new Promise((resolve) => server.listen(sock, resolve));
process.env.DOCKER_HOST = `unix://${sock}`;
process.env.HOME = dir;

const { stopOrRestart } = await import("./dist/compose.js");

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  calls = [];
  failing = null;
});

test("restart starts dependencies first, skipping the exited setup and a stopped profiled container", async () => {
  assert.equal(await stopOrRestart("restart", "sandbox-demo"), null);
  assert.deepEqual(calls, ["restart demo-cache", "restart demo-backend", "restart demo-frontend"]);
});

test("stop stops dependents first, live containers only", async () => {
  assert.equal(await stopOrRestart("stop", "sandbox-demo"), null);
  assert.deepEqual(calls, ["stop demo-backend", "stop demo-cache"]);
});

test("a failure names the container and the daemon's message, and stops there", async () => {
  failing = "demo-backend";
  const err = await stopOrRestart("restart", "sandbox-demo");
  assert.match(err, /demo-backend/);
  assert.match(err, /driver failed programming external connectivity/);
  assert.deepEqual(calls, ["restart demo-cache", "restart demo-backend"]);
});

// Last: it closes the fake daemon.
test("an unreachable daemon reads as docker not found / not running", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await stopOrRestart("stop", "sandbox-demo"), "docker not found / not running");
});
