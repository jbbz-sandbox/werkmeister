// The server cannot see the client's cwd, so the feature travels in a header
// pinned by the workspace's own .mcp.json. An explicit argument still wins --
// one agent, one container, occasionally two features.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxError } from "sandbox-core/errors";
import { FEATURE_HEADER, resolveFeature } from "./dist/lib/feature.js";

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
