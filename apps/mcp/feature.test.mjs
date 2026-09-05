// The server cannot see the client's cwd, so the feature travels in a header
// pinned by the workspace's own .mcp.json. An explicit argument still wins --
// one agent, one container, occasionally two features.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxError } from "sandbox-core/errors";
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
  // withSandboxHome seeds a config.yaml with no `paths.workspaces_root`, so
  // resolveWorkspace() falls through to cwd detection instead of a real
  // developer's ~/.sandbox — the same isolation compose-logs-guard.test.mjs
  // uses for the machine-global registry.
  await withSandboxHome(async () => {
    assert.throws(
      () => resolveWorkspaceDir("no-such-feature-mcp-task6-zzz"),
      (e) => {
        assert.ok(e instanceof SandboxError);
        assert.equal(e.code, "WORKSPACE");
        return true;
      },
    );
  });
});
