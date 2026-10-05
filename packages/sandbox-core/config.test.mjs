// The precedence rules in config.ts are what stopped the CLI and sandbox-core
// resolving different files for the same machine, so they are pinned here: the
// YAML override wins over the SANDBOX_* export (env.sh is generated FROM the
// YAML, so a disagreeing export is the stale one), and the export still beats
// the built-in default.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  configPath,
  forwardSpecs,
  infraRoot,
  sandboxHome,
  sandboxRoot,
  servicesYamlPath,
  slotPortRange,
  stateInfraRoot,
  workspacesRoot,
} from "./dist/config.js";

const VARS = [
  "SANDBOX_CONFIG_FILE",
  "SANDBOX_SERVICES_YAML",
  "SANDBOX_WORKSPACES_ROOT",
  "SANDBOX_ROOT",
];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

/** Point SANDBOX_CONFIG_FILE at a temp config.yaml holding *body*. */
async function withConfig(body) {
  const dir = await mkdtemp(path.join(tmpdir(), "sandbox-cfg-"));
  const file = path.join(dir, "config.yaml");
  await writeFile(file, body);
  process.env.SANDBOX_CONFIG_FILE = file;
  return dir;
}

beforeEach(() => VARS.forEach((v) => delete process.env[v]));
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("registry path: overrides.<key> beats the env export beats the default", async () => {
  await withConfig("overrides:\n  services_yaml: /from/yaml/services.yaml\n");
  process.env.SANDBOX_SERVICES_YAML = "/from/env/services.yaml";
  assert.equal(servicesYamlPath(), "/from/yaml/services.yaml");

  await withConfig("version: 1\n");
  process.env.SANDBOX_SERVICES_YAML = "/from/env/services.yaml";
  assert.equal(servicesYamlPath(), "/from/env/services.yaml");

  const bare = await withConfig("version: 1\n");
  delete process.env.SANDBOX_SERVICES_YAML;
  assert.equal(servicesYamlPath(), path.join(bare, "services.yaml"));
  assert.equal(sandboxHome(), bare);
  assert.equal(configPath(), path.join(bare, "config.yaml"));
});

test("workspaces root: config beats env, `~` expands, `~/workspace` is the floor", async () => {
  await withConfig("paths:\n  workspaces_root: ~/from-yaml\n");
  process.env.SANDBOX_WORKSPACES_ROOT = "/from/env";
  assert.equal(workspacesRoot(), path.join(homedir(), "from-yaml"));

  await withConfig("version: 1\n");
  assert.equal(workspacesRoot(), "/from/env");

  await withConfig("version: 1\n");
  delete process.env.SANDBOX_WORKSPACES_ROOT;
  assert.equal(workspacesRoot(), path.join(homedir(), "workspace"));
});

test("a missing config is empty, not fatal", () => {
  process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";
  assert.equal(workspacesRoot(), path.join(homedir(), "workspace"));
});

test("forwardSpecs: only k8s_forward_port entries, alias name for services only", () => {
  const specs = forwardSpecs(
    {
      backend: { k8s_forward_port: 9001, internal_port: 3000, health_endpoint: "/health" },
      aliased: { k8s_forward_port: 9002, internal_port: 80, k8s_forward_name: "real-name" },
      "not-forwarded": { internal_port: 3000 },
      bogus: "not-a-dict",
    },
    { postgres: { k8s_forward_port: 9051, internal_port: 5432, k8s_forward_name: "ignored" } },
  );
  assert.deepEqual(
    specs.map((s) => [s.name, s.listen, s.remote, s.health]),
    [
      ["backend", 9001, 3000, "/health"],
      ["real-name", 9002, 80, ""],
      // Infrastructure keys are the forward name; k8s_forward_name is a service-only alias.
      ["postgres", 9051, 5432, ""],
    ],
  );
});

test("slotPortRange: 100-port stride, span from ports.yaml", () => {
  const ports = { feature_slots: { base_port: 11100, ports_per_slot: 20 } };
  assert.deepEqual(slotPortRange(1, ports), [11100, 11119]);
  assert.deepEqual(slotPortRange(3, ports), [11300, 11319]);
  assert.deepEqual(slotPortRange(2, null), [11200, 11219]); // seeded defaults
});

// The two answers must agree, because `infra/` is reached one way from the CLI
// (which always has SANDBOX_ROOT, exported by the wrapper) and the other way
// from a bare import (the dashboard, a script), and they read the same files.
test("sandboxRoot: SANDBOX_ROOT wins, else a walk-up finds the checkout's apps/cli", () => {
  const walked = sandboxRoot();
  assert.equal(path.basename(walked), "cli");
  assert.equal(path.basename(path.dirname(walked)), "apps");
  assert.equal(infraRoot(), path.join(walked, "infra"));

  process.env.SANDBOX_ROOT = "~/elsewhere/apps/cli";
  assert.equal(sandboxRoot(), path.join(homedir(), "elsewhere", "apps", "cli"));
});

test("stateInfraRoot is <sandboxHome>/infra and follows SANDBOX_CONFIG_FILE", async () => {
  const dir = await withConfig("version: 1\n");
  assert.equal(stateInfraRoot(), path.join(dir, "infra"));
  assert.equal(stateInfraRoot(), path.join(sandboxHome(), "infra"));
});

test("stateInfraRoot is absolute even when SANDBOX_CONFIG_FILE is relative", () => {
  process.env.SANDBOX_CONFIG_FILE = "rel/config.yaml";
  assert.ok(path.isAbsolute(stateInfraRoot()), stateInfraRoot());
  assert.equal(stateInfraRoot(), path.resolve("rel", "infra"));
});
