// SW-34: compose.yml also carries the checked-out repos' other services behind the
// `on-demand` profile, so the PR gate can `up -d <svc>` one for a repo with no
// container running, while a plain `up` still starts only the workspace's services.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { generateFeatureCompose } from "./dist/generate.js";
import { withSandboxHome } from "./fixtures.mjs";

function render(local, { checkout = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-od-ws-"));
  if (checkout) fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    return withSandboxHome(async () => {
      const text = fs.readFileSync(generateFeatureCompose("f", 1, local, null, ws), "utf8");
      return { text, compose: YAML.parse(text) };
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("a checked-out repo's other services render behind the on-demand profile", async () => {
  const { text, compose } = await render(["backend"]);
  assert.deepEqual(Object.keys(compose.services).sort(), ["backend", "frontend"]);
  assert.equal(compose.services.backend.profiles, undefined);
  assert.deepEqual(compose.services.frontend.profiles, ["on-demand"]);
  assert.equal(compose.services.frontend.container_name, "f-frontend");
  assert.deepEqual(compose.services.backend.env_file, [".env", ".env.backend"]);
  assert.deepEqual(compose.services.frontend.env_file, [
    ".env",
    { path: ".env.frontend", required: false },
  ]);
  assert.match(text, /^# Local services: backend$/m);
  assert.match(text, /^# On-demand services \(the PR gate starts these\): frontend$/m);
});

test("a workspace with no services gets every repo service on demand", async () => {
  const { compose } = await render([]);
  for (const svc of ["backend", "frontend"])
    assert.deepEqual(compose.services[svc].profiles, ["on-demand"], svc);
});

test("a repo that is not checked out adds nothing", async () => {
  const { text, compose } = await render(["backend"], { checkout: false });
  assert.deepEqual(Object.keys(compose.services), ["backend"]);
  assert.doesNotMatch(text, /On-demand/);
});
