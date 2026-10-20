// The server cannot see the client's cwd, so the feature travels in a header
// pinned by the workspace's own .mcp.json. An explicit `workspace` argument
// still wins, and it may name the workspace directory or its feature.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { SandboxError } from "werkmeister-core/errors";
import { withSandboxHome } from "../../packages/sandbox-core/fixtures.mjs";
import {
  FEATURE_HEADER,
  resolveFeature,
  resolveWorkspace,
  workspaceId,
} from "./dist/lib/feature.js";

test("the header supplies the workspace when no argument does", () => {
  assert.equal(workspaceId(undefined, { [FEATURE_HEADER]: "frontend" }), "frontend");
});

test("an explicit argument overrides the header", () => {
  assert.equal(workspaceId("backend", { [FEATURE_HEADER]: "frontend" }), "backend");
});

test("neither is a coded error naming both ways to supply it", () => {
  assert.throws(
    () => workspaceId(undefined, undefined),
    (e) => {
      assert.ok(e instanceof SandboxError);
      assert.equal(e.code, "NO_WORKSPACE");
      assert.match(e.message, /`workspace`/);
      assert.match(e.message, /X-Sandbox-Feature/);
      return true;
    },
  );
});

test("blank values on either side count as absent", () => {
  assert.throws(() => workspaceId("   ", { [FEATURE_HEADER]: "  " }), { code: "NO_WORKSPACE" });
});

test("a repeated header takes the first value", () => {
  assert.equal(workspaceId(undefined, { [FEATURE_HEADER]: ["alpha", "beta"] }), "alpha");
});

// Pinning `paths.workspaces_root` to a temp dir keeps resolveWorkspace() off
// detectWorkspaceFromCwd(), which walks up from process.cwd() and would make
// these depend on whatever sits above this checkout.
async function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-workspaces-"));
  try {
    await withSandboxHome(() => fn(root), { config: `paths:\n  workspaces_root: ${root}\n` });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a workspace directory name resolves to its dir and the FEATURE in its .env", async () => {
  await withRoot((root) => {
    const dir = path.join(root, "proj-2044-frontend");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".env"), "SLOT=3\nFEATURE=frontend\n");
    assert.deepEqual(resolveWorkspace("proj-2044-frontend", undefined), {
      name: "proj-2044-frontend",
      dir,
      feature: "frontend",
    });
  });
});

test("a workspace with no FEATURE yet resolves, but not for a feature-scoped verb", async () => {
  await withRoot((root) => {
    fs.mkdirSync(path.join(root, "fresh"));
    assert.equal(resolveWorkspace("fresh", undefined).feature, null);
    assert.throws(() => resolveFeature("fresh", undefined), { code: "WORKSPACE" });
  });
});

test("a path is never read as a directory name", async () => {
  await withRoot(() => {
    assert.throws(() => resolveWorkspace("../etc", undefined), { code: "WORKSPACE" });
  });
});

test("a name no workspace or container can match is a coded WORKSPACE error", async () => {
  await withRoot(() => {
    assert.throws(
      () => resolveWorkspace("no-such-feature-mcp-zzz", undefined),
      (e) => {
        assert.ok(e instanceof SandboxError);
        assert.equal(e.code, "WORKSPACE");
        return true;
      },
    );
  });
});
