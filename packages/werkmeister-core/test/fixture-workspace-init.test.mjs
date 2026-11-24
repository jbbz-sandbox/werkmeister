// SW-218 / SW-259: init in a test must never query a Docker engine, or it can wait out the 10 s
// engine-query timeout. This asserts the cause, not wall time, which a loaded host stretches
// (SW-553, SW-1113). Its own file: docker() caches its client on first use, so init must be that use.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

// An engine that answers every request: if the dead-socket guard lets init through, it counts here.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-engine-"));
const sock = path.join(dir, "docker.sock");
let hits = 0;
const server = http.createServer((_req, res) => {
  hits++;
  res.setHeader("content-type", "application/json");
  res.end("[]");
});
await new Promise((resolve) => server.listen(sock, resolve));
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init under the fixture writes the context and wrappers without querying an engine", async () => {
  await withFixtureWorkspace(async (fx) => {
    // After fx.env, which points DOCKER_HOST at its own dead socket.
    process.env.DOCKER_HOST = `unix://${sock}`;
    await withReporter(collectingReporter(), () =>
      initWorkspace({}, fx.workspace, { build: false }),
    );
    assert.equal(hits, 0, "init reached a Docker engine (SW-218, SW-259)");
    const bin = path.join(fx.workspace, ".werkmeister", "bin");
    assert.ok(fs.statSync(path.join(bin, "with-fixture-workspace")).mode & 0o100);
    assert.match(
      fs.readFileSync(path.join(fx.workspace, ".werkmeister", "werkmeister-context.md"), "utf8"),
      /`lib`/,
    );
  });
});
