/**
 * Steps for the SW-64 spike: each scenario builds a throwaway workspace (record, code repo,
 * registry in a temp HOME) and runs the built `werkmeister pr gate` against it. No container
 * exists for the throwaway feature and it has no compose file, so the gate never starts one:
 * these scenarios need no Docker daemon. A stub `docker` can't stand in for a running container,
 * because the gate puts /usr/local/bin and /opt/homebrew/bin ahead of PATH (`childEnv`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { After, Given, Then, When } from "quickpickle";
import { expect } from "vitest";

/** Built by the `test` script. */
const MAIN = path.resolve(import.meta.dirname, "../dist/main.js");
const PASS = "| check | result |\n|---|---|\n| works | PASS |\n";

interface GateWorld {
  tmp: string;
  ws: string;
  env: NodeJS.ProcessEnv;
  gate: { status: number | null; stdout: string; stderr: string };
}

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

Given(
  "an approved workspace whose branch changes only {string}",
  (world: GateWorld, changed: string) => {
    world.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bdd-pr-gate-"));
    const home = path.join(world.tmp, "home");
    world.ws = path.join(world.tmp, "ws");

    write(path.join(home, ".werkmeister/config.yaml"), "version: 1\n");
    write(
      path.join(home, ".werkmeister/services.yaml"),
      "services:\n  app: { repo: app, path: ., type: cli, test: npm test }\n" +
        "repos:\n  app: { services: [app], no_service_paths: [docs] }\n",
    );
    write(path.join(world.ws, ".werkmeister/workspace.yml"), "feature: bdd-spike\nservices: app\n");
    write(path.join(world.ws, "stages/01_implement/output/exercise.md"), PASS);
    write(
      path.join(world.ws, "stages/02_propose/output/pr-app.md"),
      `---\nrepo: o/app\nstatus: approved\n---\n# Spike\n\n${PASS}`,
    );

    const app = path.join(world.ws, "app");
    write(path.join(app, "README.md"), "app\n");
    git(app, "init", "-q", "-b", "main");
    git(app, "remote", "add", "origin", "git@github.com:o/app.git");
    git(app, "add", ".");
    git(app, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    git(app, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(app, "switch", "-qc", "change");
    write(path.join(app, changed), "changed\n");
    git(app, "add", ".");
    git(app, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change");

    world.env = { ...process.env };
    for (const k of [
      "WERKMEISTER_ROOT",
      "WERKMEISTER_ROOT",
      "WERKMEISTER_CONFIG_FILE",
      "WERKMEISTER_CONFIG_FILE",
    ])
      delete world.env[k];
    Object.assign(world.env, {
      HOME: home,
      WERKMEISTER_CONFIG_FILE: path.join(home, ".werkmeister/config.yaml"),
    });
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
