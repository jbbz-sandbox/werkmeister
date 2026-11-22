// SW-939: a service with no health_endpoint gets one default, read by the
// compose healthcheck, the forward table and the gate's baseline row alike.
// The gate and forward callers are pinned in pr-lifecycle.test.mjs and
// config.test.mjs; this file pins the compose caller.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { DEFAULT_HEALTH_ENDPOINT, forwardSpecs } from "../dist/config.js";
import { generateFeatureCompose } from "../dist/generate.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("compose: a service with no health_endpoint is health-checked on the shared default", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "health-default-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    // The fixture registry's backend sets no health_endpoint.
    const compose = await withSandboxHome(async () =>
      YAML.parse(fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, ws), "utf8")),
    );
    const check = compose.services.backend.healthcheck.test.join(" ");
    assert.match(check, new RegExp(`localhost:\\d+${DEFAULT_HEALTH_ENDPOINT}"\\)`), check);
    assert.equal(DEFAULT_HEALTH_ENDPOINT, "/health");
    const [spec] = forwardSpecs({ backend: { k8s_forward_port: 9052, internal_port: 3000 } });
    assert.equal(spec.health, DEFAULT_HEALTH_ENDPOINT);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// SW-940: the healthcheck runs the probe health_endpoint names, as the gate's
// baseline row does, and a failing probe fails it: no `|| exit 0`.
test("compose: each health_endpoint renders its own healthcheck, and none always passes (SW-940)", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "health-probe-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  const svc = (name, offset, health) =>
    `  ${name}:\n    type: api\n    repo: demo-repo\n    port_offset: ${offset}\n    internal_port: 5432\n    health_endpoint: ${JSON.stringify(health)}\n`;
  const services = `services:\n${svc("tcp", 2, "")}${svc("pg", 3, "postgres")}${svc("rd", 4, "redis")}${svc("web", 5, "/up")}`;
  try {
    const compose = await withSandboxHome(
      async () =>
        YAML.parse(
          fs.readFileSync(
            generateFeatureCompose("f", 1, ["tcp", "pg", "rd", "web"], null, ws),
            "utf8",
          ),
        ),
      { services },
    );
    const check = (s) => compose.services[s].healthcheck.test.join(" ");
    for (const s of ["tcp", "pg", "rd", "web"]) assert.doesNotMatch(check(s), /\|\| exit 0/, s);
    assert.match(check("tcp"), /5432/);
    assert.match(check("pg"), /pg_isready .*-p 5432/);
    assert.match(check("rd"), /redis-cli -p 5432 ping/);
    assert.match(check("web"), /http:\/\/localhost:5432\/up/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
