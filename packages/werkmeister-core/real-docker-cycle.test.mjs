// SW-284: the container end-to-end check SW-184 had to fake, on SW-230's image-only service.
// Opt-in: it starts real containers, so it runs only with WERKMEISTER_REAL_DOCKER=1 and an engine.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import YAML from "yaml";

import { down, stop, up } from "./dist/lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import {
  dockerAvailable,
  pinWerkmeisterRoot,
  useDockerEngine,
  withFixtureWorkspace,
} from "./fixtures.mjs";

pinWerkmeisterRoot();
useDockerEngine();

const SERVICES = `services:
  web:
    image: nginx:alpine
    internal_port: 80
    port_offset: 1
    health_endpoint: /
`;

const status = async (name) =>
  (
    await promisify(execFile)("docker", [
      "ps",
      "-a",
      "--filter",
      `name=^${name}$`,
      "--format",
      "{{.Status}}",
    ])
  ).stdout.trim();

test("init → up → HTTP 200 → stop → down on an image-only nginx:alpine fixture", {
  skip: process.env.WERKMEISTER_REAL_DOCKER !== "1" && "set WERKMEISTER_REAL_DOCKER=1 to run",
}, async (t) => {
  if (!(await dockerAvailable())) return t.skip("no Docker engine");
  const engine = process.env.DOCKER_HOST;
  await withFixtureWorkspace(
    async (fx) => {
      // The real engine and docker CLI, in place of the fixture's dead socket and fake.
      if (engine === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = engine;
      delete process.env.WERKMEISTER_DOCKER_BIN;
      fs.writeFileSync(
        path.join(fx.workspace, ".werkmeister", "workspace.yml"),
        "feature: demo\nservices: web\n",
      );
      const quiet = (fn) => withReporter(collectingReporter(), fn);
      await quiet(() => initWorkspace({}, fx.workspace, { build: false }));
      const compose = YAML.parse(fs.readFileSync(path.join(fx.workspace, "compose.yml"), "utf8"));
      const hostPort = String(compose.services.web.ports[0]).split(":").at(-2);
      try {
        await quiet(() => up("demo", fx.workspace));
        assert.match(await status("demo-web"), /^Up/);
        assert.equal((await fetch(`http://127.0.0.1:${hostPort}/`)).status, 200);
        await quiet(() => stop("demo"));
        assert.match(await status("demo-web"), /^Exited \(0\)/);
      } finally {
        await quiet(() => down("demo"));
      }
      assert.equal(await status("demo-web"), "");
    },
    { services: SERVICES },
  );
});
