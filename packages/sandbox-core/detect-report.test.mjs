// The report exists so the command holds only printResults. Its two "nothing to
// do" paths are fields rather than throws, because each prints a different hint.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectReport } from "./dist/detect.js";

test("a missing workspace is reported, not thrown", () => {
  const r = detectReport("ghost", "/definitely/not/a/workspace");
  assert.equal(r.workspaceExists, false);
  assert.deepEqual(r.detected, []);
});

test("detected and nonLocal partition the registry", () => {
  const r = detectReport("");
  if (!r.workspaceExists || r.serviceCount === 0) return; // nothing to assert here
  const names = new Set(r.detected.map((d) => d.service));
  for (const n of r.nonLocal) assert.ok(!names.has(n));
  assert.equal(names.size + r.nonLocal.length, r.serviceCount);
});
