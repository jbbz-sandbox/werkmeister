// SW-95: a machine still running the pre-rename `sandbox-infra` stack holds the
// container names and ports 80/443 the renamed one needs, so infra start and
// `down` take it down first. `docker` is a PATH stub that logs its cwd and argv;
// HELD_PS is what `docker ps -aq` reports, LEGACY_DOWN_EXIT how the old down ends.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { down, startSharedInfra } from "./dist/infra.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { pinWerkmeisterRoot } from "./fixtures.mjs";

pinWerkmeisterRoot();

const VARS = [
  "PATH",
  "HOME",
  "WERKMEISTER_CONFIG_FILE",
  "WERKMEISTER_SERVICES_YAML",
  "WERKMEISTER_ROOT",
];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let dir, log;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "infra-retire-"));
  log = path.join(dir, "docker.log");
  const docker = path.join(dir, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
echo "$(pwd -P) | $*" >> "${log}"
case "$*" in
  "ps -aq "*) sleep "\${PS_DELAY:-0}"; printf "%s" "$HELD_PS" ;;
  "compose -p sandbox-infra "*) exit \${LEGACY_DOWN_EXIT:-0} ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  writeFileSync(path.join(dir, "services.yaml"), "services: {}\ninfrastructure: {}\n");
  process.env.PATH = `${dir}:${SAVED.PATH}`;
  process.env.HOME = dir;
  process.env.WERKMEISTER_CONFIG_FILE = path.join(dir, "config.yaml");
  process.env.WERKMEISTER_SERVICES_YAML = path.join(dir, "services.yaml");
  process.env.WERKMEISTER_ROOT = path.resolve(import.meta.dirname, "..", "..", "apps", "cli");
});
afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
  delete process.env.HELD_PS;
  delete process.env.LEGACY_DOWN_EXIT;
  delete process.env.PS_DELAY;
  rmSync(dir, { recursive: true, force: true });
});

const calls = () => readFileSync(log, "utf8").trim().split("\n");
const argvOf = (line) => line.split(" | ")[1];
const legacyIndex = (lines) =>
  lines.findIndex((l) => argvOf(l).startsWith("compose -p sandbox-infra"));
const newIndex = (lines, verb) =>
  lines.findIndex((l) => argvOf(l).includes("-p w9r-infra") && argvOf(l).includes(verb));

test("start takes the old stack down, from outside any project dir, before up", async () => {
  process.env.HELD_PS = "abc123\n";
  const ok = await withReporter(collectingReporter(), () => startSharedInfra());
  const lines = calls();
  const legacy = legacyIndex(lines);
  assert.equal(ok, true);
  assert.equal(argvOf(lines[legacy]), "compose -p sandbox-infra down --remove-orphans");
  assert.equal(lines[legacy].split(" | ")[0], realpathSync(tmpdir()));
  assert.ok(legacy < newIndex(lines, " up -d --build"), "old stack goes down before up");
});

test("start leaves compose alone when no old stack is held", async () => {
  await withReporter(collectingReporter(), () => startSharedInfra());
  const lines = calls();
  assert.equal(legacyIndex(lines), -1);
  assert.notEqual(newIndex(lines, " up -d --build"), -1);
});

test("a failed teardown warns, and up still runs", async () => {
  process.env.HELD_PS = "abc123\n";
  process.env.LEGACY_DOWN_EXIT = "1";
  const reporter = collectingReporter();
  const ok = await withReporter(reporter, () => startSharedInfra());
  assert.equal(ok, true);
  assert.match(reporter.text(), /Could not take down sandbox-infra/);
  assert.notEqual(newIndex(calls(), " up -d --build"), -1);
});

test("down --volumes takes the old stack's volumes too", async () => {
  process.env.HELD_PS = "abc123\n";
  await withReporter(collectingReporter(), () => down(true));
  const lines = calls();
  const legacy = legacyIndex(lines);
  assert.equal(argvOf(lines[legacy]), "compose -p sandbox-infra down --remove-orphans --volumes");
  assert.ok(legacy < newIndex(lines, " down"));
});

// SW-257: a loaded host can make the held-containers probe slow; that must not skip the teardown.
test("a slow probe does not skip the old stack's teardown", async () => {
  process.env.HELD_PS = "abc123\n";
  process.env.PS_DELAY = "11";
  await withReporter(collectingReporter(), () => down(true));
  assert.notEqual(legacyIndex(calls()), -1);
});
