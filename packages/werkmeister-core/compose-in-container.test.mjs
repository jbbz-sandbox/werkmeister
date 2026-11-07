// SW-554: inside a workspace container sandboxRoot() is the container's /app, while compose.yml
// is read by the host's Docker. A regeneration from there with the WERKMEISTER_FEATURE guard
// unset wrote /app/... into the install's script mount, so the host ran an empty script and
// exited 0. The generator refuses on Docker's marker alone; a relocated config (what every
// test and fixture sets) still writes.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { COMPOSE_FILE } from "./dist/compose_file.js";
import { generateFeatureCompose, refuseComposeInsideContainer } from "./dist/generate.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

// The container's shape: no relocated config, the registry under HOME, the guard env unset.
const GUARD = ["WERKMEISTER_FEATURE", "SANDBOX_FEATURE", "WERKMEISTER_CONFIG_FILE"];
const SERVICES = `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    setup_service: demo-install
setup_services:
  demo-install:
    repo: demo-repo
    image: node:22-alpine
    command: "npm install"
    startup_script: true
`;

test("refuseComposeInsideContainer reads Docker's marker, let through by a relocated config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-dockerenv-"));
  const marker = path.join(dir, ".dockerenv");
  const saved = process.env.WERKMEISTER_CONFIG_FILE;
  delete process.env.WERKMEISTER_CONFIG_FILE;
  try {
    assert.doesNotThrow(() => refuseComposeInsideContainer(marker));
    fs.writeFileSync(marker, "");
    assert.throws(() => refuseComposeInsideContainer(marker), { code: "INSIDE_CONTAINER" });
    process.env.WERKMEISTER_CONFIG_FILE = path.join(dir, "config.yaml");
    assert.doesNotThrow(() => refuseComposeInsideContainer(marker));
  } finally {
    if (saved === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inside a container, with the guard env unset, compose.yml keeps its host paths", {
  skip: !fs.existsSync("/.dockerenv") && "needs a workspace container",
}, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-ic-ws-"));
  const file = path.join(ws, COMPOSE_FILE);
  const before =
    "services: {}\n# - /Users/me/repos/werkmeister/apps/cli/infra/compose/scripts/x.sh\n";
  fs.writeFileSync(file, before);
  const saved = Object.fromEntries(GUARD.map((k) => [k, process.env[k]]));
  try {
    await withSandboxHome(
      async (home) => {
        const dot = path.join(process.env.HOME, ".werkmeister");
        fs.mkdirSync(dot);
        for (const f of ["config.yaml", "services.yaml", "ports.yaml"])
          fs.copyFileSync(path.join(home, f), path.join(dot, f));
        for (const k of GUARD) delete process.env[k];
        assert.throws(() => generateFeatureCompose("f", 1, ["backend"], null, ws), {
          code: "INSIDE_CONTAINER",
        });
      },
      { services: SERVICES },
    );
    assert.equal(fs.readFileSync(file, "utf8"), before);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
