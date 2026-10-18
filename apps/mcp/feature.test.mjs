// The server cannot see the client's cwd, so the feature travels in a header
// pinned by the workspace's own .mcp.json. An explicit argument still wins --
// one agent, one container, occasionally two features.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { SandboxError } from "werkmeister-core/errors";
import { withSandboxHome } from "../../packages/sandbox-core/fixtures.mjs";
import { FEATURE_HEADER, resolveFeature, resolveWorkspaceDir } from "./dist/lib/feature.js";

test("the header supplies the feature when no argument does", () => {
  assert.equal(resolveFeature(undefined, { [FEATURE_HEADER]: "frontend" }), "frontend");
});

test("an explicit argument overrides the header", () => {
  assert.equal(resolveFeature("backend", { [FEATURE_HEADER]: "frontend" }), "backend");
});

test("neither is a coded error naming both ways to supply it", () => {
  assert.throws(
    () => resolveFeature(undefined, undefined),
    (e) => {
      assert.ok(e instanceof SandboxError);
      assert.equal(e.code, "NO_FEATURE");
      assert.match(e.message, /feature/);
      assert.match(e.message, /X-Sandbox-Feature/);
      return true;
    },
  );
});

test("blank values on either side count as absent", () => {
  assert.throws(() => resolveFeature("   ", { [FEATURE_HEADER]: "  " }), { code: "NO_FEATURE" });
});

test("a repeated header takes the first value", () => {
  assert.equal(resolveFeature(undefined, { [FEATURE_HEADER]: ["alpha", "beta"] }), "alpha");
});

test("a feature no workspace or container can match is a coded WORKSPACE error", async () => {
  // Pinning `paths.workspaces_root` to an empty temp dir forces
  // resolveWorkspace() into its "configured" branch instead of falling
  // through to detectWorkspaceFromCwd(), which walks up from process.cwd()
  // for a .git boundary and would otherwise make this test depend on
  // whatever sits above this checkout on the machine that runs it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task6-workspaces-"));
  try {
    await withSandboxHome(
      async () => {
        assert.throws(
          () => resolveWorkspaceDir("no-such-feature-mcp-task6-zzz"),
          (e) => {
            assert.ok(e instanceof SandboxError);
            assert.equal(e.code, "WORKSPACE");
            return true;
          },
        );
      },
      { config: `paths:\n  workspaces_root: ${root}\n` },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
