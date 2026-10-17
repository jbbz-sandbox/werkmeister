// workspaceForFeature falls back to resolveWorkspace() — cwd-based — when no
// container carries the feature's label. Run from inside a workspace, that
// returns the *enclosing* workspace whatever feature was asked for, so a
// feature that does not exist resolves to someone else's compose file
// (#101: compose-logs.smoke got a live child for "no-such-feature-hopefully").
//
// Hermetic: a temp workspaces_root holds one workspace whose .env names its
// own feature, and the test runs with cwd inside it. The directory name
// differs from the feature on purpose — `sandbox workspace` names directories
// `<repo>-<issue>-<feature>`, so the dir is not the feature.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { workspaceForFeature } from "./dist/compose.js";
import { COMPOSE_FILE, LEGACY_COMPOSE_FILE } from "./dist/compose_file.js";
import { withSandboxHome } from "./fixtures.mjs";

async function insideWorkspace(fn, composeName = COMPOSE_FILE) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-ws-root-")));
  const ws = path.join(root, "sandbox-999-owner-feature");
  fs.mkdirSync(path.join(ws, "repo"), { recursive: true });
  fs.writeFileSync(path.join(ws, composeName), "services: {}\n");
  fs.writeFileSync(path.join(ws, ".env"), "# Workspace metadata\nFEATURE=owner-feature\n");
  const prevCwd = process.cwd();
  try {
    return await withSandboxHome(
      async () => {
        process.chdir(path.join(ws, "repo"));
        return fn(ws);
      },
      { config: `paths:\n  workspaces_root: ${root}\n` },
    );
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a feature the enclosing workspace does not belong to resolves to null", async () => {
  await insideWorkspace(() => {
    assert.equal(workspaceForFeature("no-such-feature-hopefully"), null);
  });
});

test("the enclosing workspace still resolves for its own feature", async () => {
  await insideWorkspace((ws) => {
    assert.equal(workspaceForFeature("owner-feature"), ws);
  });
});

test("a workspace not yet migrated off the legacy file still resolves (#224)", async () => {
  await insideWorkspace((ws) => {
    assert.equal(workspaceForFeature("owner-feature"), ws);
  }, LEGACY_COMPOSE_FILE);
});
