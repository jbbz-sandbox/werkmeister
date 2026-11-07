// SW-541: compose re-runs an exited setup service (werkmeister-install) on every
// `up -d --wait <svc>` through its service_completed_successfully depends_on, so
// each gate or `feature up --service` start re-ran the install and its build.
// Once the install has succeeded for the current lockfile + Node major (the
// worktree stamp startup.sh writes) and its container exited 0, setupsCurrent holds
// and the gate's start passes --no-deps. A fake docker CLI records the argv and a
// fake Engine on a unix socket answers the container inspect; no daemon.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import { useDockerEngine } from "./fixtures.mjs";

useDockerEngine();

/** demo-install's state as the fake Engine reports it; null is a 404 (removed by `down -v`). */
let installState;
beforeEach(() => {
  installState = { Status: "exited", ExitCode: 0 };
});
const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw541-engine-"));
const sock = path.join(engineDir, "docker.sock");
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.endsWith("/containers/demo-install/json") && installState) {
    res.end(JSON.stringify({ Id: "demo-install-id", State: installState }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ message: "No such container" }));
});
await new Promise((resolve) => server.listen(sock, resolve));
process.env.DOCKER_HOST = `unix://${sock}`;
// No ~/.docker context may beat DOCKER_HOST.
process.env.HOME = engineDir;
const dirs = [engineDir];
after(() => {
  server.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const { composeUpServiceAsync } = await import("./dist/compose.js");
const { setupsCurrent } = await import("./dist/scheduler_state.js");

const LOCK = "lockfileVersion: '9.0'\n";

/** A workspace with one worktree, its compose.yml and a fake docker that logs each argv. */
function workspace({ stamp, image = "node:22", extraDep = false } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sw541-"));
  dirs.push(ws);
  const wt = path.join(ws, "repo");
  fs.mkdirSync(path.join(wt, ".turbo"), { recursive: true });
  fs.writeFileSync(path.join(wt, "pnpm-lock.yaml"), LOCK);
  if (stamp !== undefined)
    fs.writeFileSync(path.join(wt, ".turbo/.werkmeister-install-hash"), `${stamp}\n`);
  const deps = ["      install:\n        condition: service_completed_successfully\n"];
  if (extraDep) deps.push("      db:\n        condition: service_healthy\n");
  fs.writeFileSync(
    path.join(ws, "compose.yml"),
    "services:\n" +
      `  install:\n    image: ${image}\n    container_name: demo-install\n    labels:\n      com.werkmeister.role: "setup"\n` +
      `    working_dir: /app\n    volumes:\n      - ${wt}:/app\n      - demo-node-modules:/app/node_modules\n` +
      "  db:\n    image: postgres:16\n" +
      `  cli:\n    image: node:22\n    depends_on:\n${deps.join("")}`,
  );
  const log = path.join(ws, "docker.log");
  const bin = path.join(ws, "docker");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
  return { ws, wt, bin, log };
}

/** The stamp startup.sh writes: sha256 of the lockfile, then the Node major. */
const want = (major = "v22") => `${createHash("sha256").update(LOCK).digest("hex")} ${major}`;

const current = (w) => setupsCurrent(path.join(w.ws, "compose.yml"), "cli");

async function upArgv(w, noDeps) {
  const prev = process.env.WERKMEISTER_DOCKER_BIN;
  process.env.WERKMEISTER_DOCKER_BIN = w.bin;
  try {
    const up = composeUpServiceAsync("demo", "cli", path.join(w.ws, "compose.yml"), noDeps);
    assert.equal(await up, true);
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_DOCKER_BIN;
    else process.env.WERKMEISTER_DOCKER_BIN = prev;
  }
  return fs
    .readFileSync(w.log, "utf8")
    .split("\n")
    .find((l) => / up /.test(` ${l} `))
    .split(" ");
}

test("a start after the install succeeded for the current stamp does not re-run it", async () => {
  const w = workspace({ stamp: want() });
  assert.equal(await current(w), true);
  assert.ok((await upArgv(w, true)).includes("--no-deps"));
});

test("a start not told to skip keeps its deps (feature up --service)", async () => {
  assert.ok(!(await upArgv(workspace({ stamp: want() }), false)).includes("--no-deps"));
});

test("the first start (no stamp yet) runs the install", async () => {
  assert.equal(await current(workspace()), false);
});

test("a changed lockfile runs the install", async () => {
  const w = workspace({ stamp: want() });
  fs.appendFileSync(path.join(w.wt, "pnpm-lock.yaml"), "packages: {}\n");
  assert.equal(await current(w), false);
});

test("a new Node major runs the install", async () => {
  assert.equal(await current(workspace({ stamp: want(), image: "node:24" })), false);
});

test("an install removed by `down -v` runs again, though the worktree stamp is left", async () => {
  installState = null;
  assert.equal(await current(workspace({ stamp: want() })), false);
});

test("an install whose build failed after the stamp runs again", async () => {
  installState = { Status: "exited", ExitCode: 1 };
  assert.equal(await current(workspace({ stamp: want() })), false);
});

test("a service with a non-setup dependency keeps its deps", async () => {
  assert.equal(await current(workspace({ stamp: want(), extraDep: true })), false);
});
