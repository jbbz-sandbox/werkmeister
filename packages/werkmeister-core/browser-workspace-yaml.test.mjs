// Takes a resolved workspace, not a cwd to walk up from: the walk-up is the
// CLI's job (§7 -- cwd resolution stays there), and a caller that is not
// standing in a workspace has no meaningful cwd to start one from.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { readWorkspaceYaml } from "./dist/browser.js";

const workspace = (contents, name = "workspace.yml") => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  if (contents !== null) {
    fs.mkdirSync(path.join(ws, ".werkmeister"));
    fs.writeFileSync(path.join(ws, ".werkmeister", name), contents);
  }
  return ws;
};

test("reads .werkmeister/workspace.yml from the given workspace", () => {
  assert.equal(readWorkspaceYaml(workspace("test_path: /checkout\n")).test_path, "/checkout");
});

test("accepts the .yaml spelling too", () => {
  const ws = workspace("test_path: /y\n", "workspace.yaml");
  assert.equal(readWorkspaceYaml(ws).test_path, "/y");
});

test("returns an empty object for a missing file", () => {
  assert.deepEqual(readWorkspaceYaml(workspace(null)), {});
});

test("returns an empty object for malformed yaml rather than throwing", () => {
  // A broken workspace.yml must not take down a browser launch: the caller
  // falls back to its own defaults for test_path.
  assert.deepEqual(readWorkspaceYaml(workspace("{{{ not yaml")), {});
});

test("returns an empty object when the yaml is a scalar, not a mapping", () => {
  assert.deepEqual(readWorkspaceYaml(workspace("just-a-string\n")), {});
});
