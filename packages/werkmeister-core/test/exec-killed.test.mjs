// SW-856: a stop werkmeister makes on its own (preemption, the idle reaper) names each `docker exec`
// it kills to the workspace's session. A fake Engine on a unix socket; no real daemon.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { runningExecCommands } from "../dist/docker.js";
import { killedNudge } from "../dist/lifecycle.js";
import { useDockerEngine } from "./fixtures.mjs";

useDockerEngine();

const dir = fs.mkdtempSync(path.join(tmpdir(), "exec-killed-"));
const sock = path.join(dir, "docker.sock");
const CONTAINERS = { "demo-core": ["e1", "e2"], "demo-db": null };
const EXECS = {
  e1: { Running: true, ProcessConfig: { entrypoint: "pnpm", arguments: ["turbo", "run", "test"] } },
  e2: { Running: false, ProcessConfig: { entrypoint: "true", arguments: [] } },
};
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  const c = /\/containers\/([^/]+)\/json$/.exec(req.url);
  const e = /\/exec\/([^/]+)\/json$/.exec(req.url);
  const body = c ? c[1] in CONTAINERS && { ExecIDs: CONTAINERS[c[1]] } : e && EXECS[e[1]];
  if (!body) res.statusCode = 404;
  res.end(JSON.stringify(body || { message: "No such object" }));
});
await new Promise((r) => server.listen(sock, r));
process.env.DOCKER_HOST = `unix://${sock}`;
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runningExecCommands: running execs only, none for a container with none or gone (SW-856)", async () => {
  assert.deepEqual(await runningExecCommands(["demo-core", "demo-db", "gone"]), [
    "pnpm turbo run test",
  ]);
  assert.deepEqual(await runningExecCommands([]), []);
});

test("killedNudge names why, each killed command, and that it needs a rerun (SW-856)", () => {
  const text = killedNudge("preempted to make room for 'other'", ["pnpm turbo run test"]);
  assert.match(text, /\(preempted to make room for 'other'\)/);
  assert.match(text, /`pnpm turbo run test`/);
  assert.match(text, /killed \(exit 137\), not failed/);
  assert.match(text, /rerun them/);
});
