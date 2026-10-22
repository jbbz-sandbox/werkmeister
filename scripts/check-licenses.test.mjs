import assert from "node:assert/strict";
import { test } from "node:test";
import { allowed, check } from "./check-licenses.mjs";

test("allowed: OR needs one branch, AND needs every term", () => {
  assert.ok(allowed("MIT"));
  assert.ok(allowed("(MIT OR GPL-3.0-or-later)"));
  assert.ok(allowed("(MIT AND Zlib)"));
  assert.ok(!allowed("GPL-3.0-only"));
  assert.ok(!allowed("(MIT AND GPL-3.0-only)"));
  assert.ok(!allowed("SEE LICENSE IN LICENSE.md"));
});

test("check: flags unknown and missing licences, skips reviewed packages and their platform twins", () => {
  const listing = {
    ISC: [{ name: "ok", versions: ["1.0.0"] }],
    "GPL-3.0-only": [{ name: "gpl", versions: ["2.0.0"] }],
    Unknown: [
      { name: "missing", versions: ["3.0.0", "3.1.0"] },
      { name: "@anthropic-ai/claude-agent-sdk-linux-x64", versions: ["1.0.0"] },
    ],
  };
  assert.deepEqual(check(listing), [
    "gpl@2.0.0: GPL-3.0-only",
    "missing@3.0.0, 3.1.0: no licence field",
  ]);
});
