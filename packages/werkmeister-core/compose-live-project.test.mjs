// SW-93: a workspace brought up before the rename runs under `sandbox-<feature>`
// until its next `up`; stop, restart, logs and status must keep reaching it there.
// A fake Engine on a unix socket answers by compose project label.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

let projects = [];
const dir = mkdtempSync(path.join(tmpdir(), "live-project-"));
const sock = path.join(dir, "docker.sock");
const server = http.createServer((req, res) => {
  const labels = JSON.parse(new URL(req.url, "http://engine").searchParams.get("filters")).label;
  const project = labels[0].split("=")[1];
  const rows = projects
    .filter((p) => p === project)
    .map((p) => ({
      Id: `${p}-id`,
      Names: [`/${p}-api`],
      State: "running",
      Status: "Up 1 hour",
      Ports: [],
      Labels: { "com.docker.compose.project": p, "com.docker.compose.service": "api" },
    }));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(rows));
});
await new Promise((resolve) => server.listen(sock, resolve));
process.env.DOCKER_HOST = `unix://${sock}`;

const { liveProject } = await import("./dist/compose.js");

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("liveProject: the sandbox- project while it holds containers, else werkmeister-", async () => {
  projects = ["sandbox-demo"];
  assert.equal(await liveProject("demo"), "sandbox-demo");
  projects = ["werkmeister-demo"];
  assert.equal(await liveProject("demo"), "werkmeister-demo");
  projects = [];
  assert.equal(await liveProject("demo"), "werkmeister-demo");
});
