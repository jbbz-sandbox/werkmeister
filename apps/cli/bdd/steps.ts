/**
 * Steps for the SW-64 spike: each scenario seeds the shared fixture (SW-427: the same seed and fakes
 * as `with-fixture-workspace`) and runs the built `werkmeister pr gate` against it. The fake docker
 * shows no container running and the workspace has no compose file, so the gate never starts one.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { After, Given, Then, When } from "quickpickle";
import { expect } from "vitest";
import { seedFixture } from "werkmeister-core/fixture_workspace";

/** Built by the `test` script. */
const MAIN = path.resolve(import.meta.dirname, "../dist/main.js");

interface GateWorld {
  tmp: string;
  ws: string;
  env: NodeJS.ProcessEnv;
  gate: { status: number | null; stdout: string; stderr: string };
}

Given(
  "an approved workspace whose branch changes only {string}",
  (world: GateWorld, changed: string) => {
    world.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bdd-pr-gate-")));
    const fx = seedFixture(world.tmp, {
      services:
        "services:\n  app: { repo: app, path: ., type: cli, test: npm test }\n" +
        "repos:\n  app: { services: [app], no_service_paths: [docs] }\n",
      workspaceServices: ["app"],
      repos: [{ name: "app", change: changed }],
      prFile: true,
    });
    world.ws = fx.workspace;
    world.env = { ...process.env, ...fx.env };
    delete world.env.WERKMEISTER_ROOT;
  },
);

When("the PR gate runs", (world: GateWorld) => {
  world.gate = spawnSync(process.execPath, [MAIN, "pr", "gate"], {
    cwd: world.ws,
    env: world.env,
    encoding: "utf8",
  });
});

Then("the gate passes", (world: GateWorld) => {
  expect(world.gate.status, world.gate.stdout + world.gate.stderr).toBe(0);
  expect(world.gate.stdout).toContain("gate passed");
});

Then("no service tests ran", (world: GateWorld) => {
  // A touched service adds a `test <svc>` check, and a started container a `start`/`containers` one.
  expect(world.gate.stdout).not.toMatch(/^ {2}[✓✗] (test|start|containers)\b/m);
});

Then("the gate fails on the tests for {string}", (world: GateWorld, service: string) => {
  expect(world.gate.status).toBe(1);
  expect(world.gate.stdout).toContain("gate FAILED");
  expect(world.gate.stdout).toMatch(new RegExp(`^ {2}✗ test ${service}:`, "m"));
});

After((world: GateWorld) => {
  if (world.tmp) fs.rmSync(world.tmp, { recursive: true, force: true });
});
