// SW-76: plain `docker compose down` skips a service whose profile is off, so
// an opted-in redisinsight/jaeger (or one left running from before it became
// opt-in) would survive `down infra`. `docker` is a PATH stub that logs its
// argv; HOME is a temp dir so stopAll() finds no real web-server pid files.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { down } from "../dist/infra.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { pinWerkmeisterRoot } from "./fixtures.mjs";

pinWerkmeisterRoot();

const VARS = [
  "PATH",
  "HOME",
  "WERKMEISTER_CONFIG_FILE",
  "WERKMEISTER_SERVICES_YAML",
  "WERKMEISTER_ROOT",
  "WERKMEISTER_DOCKER_BIN",
];
const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let dir, log;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "infra-down-"));
  log = path.join(dir, "docker.log");
  const docker = path.join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(docker, 0o755);
  writeFileSync(path.join(dir, "services.yaml"), "services: {}\ninfrastructure: {}\n");
  process.env.PATH = `${dir}:${SAVED.PATH}`;
  process.env.HOME = dir;
  delete process.env.WERKMEISTER_DOCKER_BIN; // the PATH stub, never a docker the env points at
  process.env.WERKMEISTER_CONFIG_FILE = path.join(dir, "config.yaml");
  process.env.WERKMEISTER_SERVICES_YAML = path.join(dir, "services.yaml");
  process.env.WERKMEISTER_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "cli");
});
afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
  rmSync(dir, { recursive: true, force: true });
});

test("down removes every profile's containers, not just the default set", async () => {
  assert.equal(await withReporter(collectingReporter(), () => down()), true);
  const call = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .find((l) => l.includes(" down"));
  assert.match(call, /-p w9r-infra --profile \* down$/);
});

test("down resolves false when docker compose down fails, so an SDK caller can tell", async () => {
  writeFileSync(
    path.join(dir, "docker"),
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *" down"*) exit 1;; esac\n`,
  );
  assert.equal(await withReporter(collectingReporter(), () => down()), false);
});
