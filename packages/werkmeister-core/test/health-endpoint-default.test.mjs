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
    assert.match(check, new RegExp(`localhost:\\d+${DEFAULT_HEALTH_ENDPOINT} `), check);
    assert.equal(DEFAULT_HEALTH_ENDPOINT, "/health");
    const [spec] = forwardSpecs({ backend: { k8s_forward_port: 9052, internal_port: 3000 } });
    assert.equal(spec.health, DEFAULT_HEALTH_ENDPOINT);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
