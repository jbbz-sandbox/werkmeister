// The report exists so the command holds only printResults. Its two "nothing to
// do" paths are fields rather than throws, because each prints a different hint.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectReport } from "./dist/detect.js";
import { withSandboxHome } from "./fixtures.mjs";

test("a missing workspace is reported, not thrown", () => {
  const r = detectReport("ghost", "/definitely/not/a/workspace");
  assert.equal(r.workspaceExists, false);
  assert.deepEqual(r.detected, []);
});

// Hermetic: against a seeded registry rather than whatever this machine has
// declared, so the partition is an actual assertion rather than an early return.
test("detected and nonLocal partition the registry", async () => {
  await withSandboxHome(async (home) => {
    const r = detectReport("", home);
    assert.equal(r.serviceCount, 2);
    const names = new Set(r.detected.map((d) => d.service));
    for (const n of r.nonLocal) assert.ok(!names.has(n), `${n} is in both halves`);
    assert.equal(names.size + r.nonLocal.length, r.serviceCount);
  });
});
