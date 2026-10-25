// A workspace container's generated `.env` exports COMPOSE_PROJECT_NAME=sandbox-<caller>,
// which outranks a compose file's `name:`. Running `sandbox workspace` in there built
// the new workspace's images under the caller's project and recreated its containers
// (#225, same leak as #198 for infra). Every workspace compose argv must carry `-p`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { workspaceComposeArgv } from "./dist/compose.js";

test("names the workspace project even when the caller's env sets COMPOSE_PROJECT_NAME", () => {
  process.env.COMPOSE_PROJECT_NAME = "sandbox-other";
  try {
    assert.deepEqual(workspaceComposeArgv("demo", ["ps"], "/w/compose.yml"), [
      "docker",
      "compose",
      "-f",
      "/w/compose.yml",
      "-p",
      "werkmeister-demo",
      "ps",
    ]);
  } finally {
    delete process.env.COMPOSE_PROJECT_NAME;
  }
});

test("without a compose path it relies on cwd, still pinning the project", () => {
  assert.deepEqual(workspaceComposeArgv("demo", ["up", "--build", "--no-start"]), [
    "docker",
    "compose",
    "-p",
    "werkmeister-demo",
    "up",
    "--build",
    "--no-start",
  ]);
});

// SW-93: a workspace generated before the rename keeps its project until its next `up`
// regenerates the file; a `-p` that disagreed would start a second copy beside it.
test("pins the project the compose file names, so an old workspace keeps its sandbox- project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-project-"));
  const file = path.join(dir, "compose.yml");
  fs.writeFileSync(file, "# header\nname: sandbox-demo\n\nservices: {}\n");
  assert.equal(workspaceComposeArgv("demo", ["ps"], file)[5], "sandbox-demo");
  fs.writeFileSync(file, "name: werkmeister-demo\nservices: {}\n");
  assert.equal(workspaceComposeArgv("demo", ["ps"], file)[5], "werkmeister-demo");
});
