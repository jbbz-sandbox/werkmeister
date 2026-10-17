// A workspace container's generated `.env` exports COMPOSE_PROJECT_NAME=sandbox-<caller>,
// which outranks a compose file's `name:`. Running `sandbox workspace` in there built
// the new workspace's images under the caller's project and recreated its containers
// (#225, same leak as #198 for infra). Every workspace compose argv must carry `-p`.

import assert from "node:assert/strict";
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
      "sandbox-demo",
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
    "sandbox-demo",
    "up",
    "--build",
    "--no-start",
  ]);
});
