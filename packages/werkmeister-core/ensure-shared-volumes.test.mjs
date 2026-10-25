// SW-69: `up` creates only the shared volumes this workspace's compose marks
// external, not every `^` volume in the registry, so a workspace that mounts
// no cache never creates one. `docker` is a PATH stub that logs its argv.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ensureSharedVolumes } from "./dist/compose.js";

const SAVED_PATH = process.env.PATH;
let dir, log;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ensure-volumes-"));
  log = path.join(dir, "docker.log");
  const docker = path.join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(docker, 0o755);
  process.env.PATH = `${dir}:${SAVED_PATH}`;
});
afterEach(() => {
  process.env.PATH = SAVED_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function ensure(composeText) {
  const file = path.join(dir, "compose.yml");
  writeFileSync(file, composeText);
  ensureSharedVolumes(file);
  try {
    return readFileSync(log, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

test("a compose with no external volume creates nothing", () => {
  assert.deepEqual(ensure("volumes:\n  alpha-node-modules:\n    name: alpha-node-modules\n"), []);
  assert.deepEqual(ensure("services: {}\n"), []);
});

test("only the external volumes are created, by their name", () => {
  const created = ensure(`volumes:
  alpha-node-modules:
    name: alpha-node-modules
  werkmeister-pnpm-store:
    name: werkmeister-pnpm-store
    external: true
  turbo:
    name: werkmeister-turbo
    external: true
`);
  assert.deepEqual(created, ["volume create werkmeister-pnpm-store", "volume create werkmeister-turbo"]);
});
