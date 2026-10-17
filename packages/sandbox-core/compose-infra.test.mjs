// Every `docker compose` call the CLI makes goes through one helper, so the
// shipped file, the generated override and the env var the shipped file
// interpolates can never disagree. The override must exist before the first
// call on a fresh machine (`sandbox status` before any `connect`), so the
// helper creates it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { composeInvocation } from "./dist/compose_infra.js";
import { infraRoot, stateInfraRoot } from "./dist/config.js";

const VARS = [
  "SANDBOX_CONFIG_FILE",
  "SANDBOX_SERVICES_YAML",
  "SANDBOX_ROOT",
  "COMPOSE_PROJECT_NAME",
];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

const REGISTRY = `
services: {}
infrastructure:
  redis:
    k8s_forward_port: 9050
    internal_port: 6379
    k8s_namespace: default
    k8s_pod_prefix: redis
    health_endpoint: ""
`;

let home;
beforeEach(async () => {
  for (const v of VARS) delete process.env[v];
  home = await mkdtemp(path.join(tmpdir(), "sandbox-compose-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "config.yaml");
  await writeFile(path.join(home, "services.yaml"), REGISTRY);
  process.env.SANDBOX_SERVICES_YAML = path.join(home, "services.yaml");
  process.env.SANDBOX_ROOT = path.resolve(import.meta.dirname, "..", "..", "apps", "cli");
});
afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
});

test("argv names the shipped file then the override, env carries SANDBOX_STATE_DIR", () => {
  const { argv, env } = composeInvocation();
  assert.deepEqual(argv.slice(0, 2), ["docker", "compose"]);
  assert.deepEqual(argv.slice(2), [
    "-f",
    path.join(infraRoot(), "compose", "shared-infra.yml"),
    "-f",
    path.join(stateInfraRoot(), "compose", "k8s-forwards.override.yml"),
    "-p",
    "sandbox-infra",
  ]);
  assert.equal(env.SANDBOX_STATE_DIR, path.join(home, "infra"));
  assert.equal(env.PATH, process.env.PATH, "inherits the process env");
});

// Inside a workspace container the generated `.env` exports
// COMPOSE_PROJECT_NAME=sandbox-<feature>, which beats shared-infra.yml's
// `name:` — the shared stack was then addressed as the workspace's project
// (#198). `-p` beats the env var.
test("names the infra project even when the caller's env sets COMPOSE_PROJECT_NAME", () => {
  process.env.COMPOSE_PROJECT_NAME = "sandbox-demo";
  const { argv } = composeInvocation();
  assert.deepEqual(argv.slice(-2), ["-p", "sandbox-infra"]);
});

test("creates the override from the registry when it is missing", () => {
  const override = path.join(home, "infra", "compose", "k8s-forwards.override.yml");
  assert.equal(existsSync(override), false);
  composeInvocation();
  assert.ok(existsSync(override));
  assert.match(readFileSync(override, "utf8"), /- "9050:9050" {3}# redis/);
});

test("leaves an existing override alone", async () => {
  const override = path.join(home, "infra", "compose", "k8s-forwards.override.yml");
  composeInvocation();
  await writeFile(override, "services: {}\n# sentinel\n");
  composeInvocation();
  assert.match(readFileSync(override, "utf8"), /sentinel/);
});
