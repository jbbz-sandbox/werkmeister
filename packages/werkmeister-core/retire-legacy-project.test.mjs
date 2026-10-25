// SW-93: the first `up` after the rename must take down the workspace's old
// `sandbox-<feature>` project (its containers hold the names the new project
// needs), and `down --volumes` must reach the volumes the old project created.
// `docker` is a PATH stub that logs its argv and cwd; HELD lists what it reports.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { retireLegacyProject } from "./dist/compose.js";

const SAVED_PATH = process.env.PATH;
let dir, log, compose;

/** Stub `docker`: `ps` prints $HELD_PS, `volume ls` prints $HELD_VOLUMES, everything is logged. */
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "retire-legacy-"));
  log = path.join(dir, "docker.log");
  const docker = path.join(dir, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
echo "$(pwd -P) | $*" >> "${log}"
case "$1 $2" in
  "ps -aq") printf "%s" "$HELD_PS" ;;
  "volume ls") printf "%s" "$HELD_VOLUMES" ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  process.env.PATH = `${dir}:${SAVED_PATH}`;
  compose = path.join(dir, "compose.yml");
  writeFileSync(compose, "name: werkmeister-demo\nservices: {}\n");
});
afterEach(() => {
  process.env.PATH = SAVED_PATH;
  delete process.env.HELD_PS;
  delete process.env.HELD_VOLUMES;
  rmSync(dir, { recursive: true, force: true });
});

function retire(opts) {
  retireLegacyProject("demo", compose, opts);
  try {
    return readFileSync(log, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

const downs = (lines) => lines.filter((l) => l.includes(" | compose "));

test("takes down the old project, from outside the workspace, without its volumes", () => {
  process.env.HELD_PS = "abc123\n";
  const lines = downs(retire());
  assert.equal(lines.length, 1);
  const [cwd, argv] = lines[0].split(" | ");
  assert.equal(argv, "compose -p sandbox-demo down --remove-orphans");
  assert.notEqual(cwd, dir);
});

test("does nothing when the old project holds nothing", () => {
  assert.deepEqual(downs(retire()), []);
  assert.deepEqual(downs(retire({ removeVolumes: true })), []);
});

test("down --volumes reaches the old project's volumes even with no containers left", () => {
  process.env.HELD_VOLUMES = "demo-node-modules\n";
  assert.deepEqual(
    downs(retire({ removeVolumes: true })).map((l) => l.split(" | ")[1]),
    ["compose -p sandbox-demo down --remove-orphans --volumes"],
  );
});

test("a compose file still naming the old project is left alone: that workspace hasn't moved yet", () => {
  writeFileSync(compose, "name: sandbox-demo\nservices: {}\n");
  process.env.HELD_PS = "abc123\n";
  assert.deepEqual(retire({ removeVolumes: true }), []);
});
