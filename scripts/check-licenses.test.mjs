import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("check: flags unknown licences, reads legacy `licenses`, skips reviewed packages", () => {
  const root = mkdtempSync(join(tmpdir(), "licenses-"));
  mkdirSync(join(root, "node_modules/old"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/old/package.json"),
    JSON.stringify({ licenses: [{ type: "MIT" }] }),
  );
  const packages = {
    "": {},
    "node_modules/ok": { version: "1.0.0", license: "ISC" },
    "node_modules/old": { version: "1.0.0" },
    "node_modules/gpl": { version: "2.0.0", license: "GPL-3.0-only" },
    "node_modules/missing": { version: "3.0.0" },
    "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64": {
      version: "1.0.0",
      license: "SEE LICENSE IN LICENSE.md",
    },
    "node_modules/werkmeister": { link: true },
  };
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages }));
  assert.deepEqual(check(root), ["gpl@2.0.0: GPL-3.0-only", "missing@3.0.0: no licence field"]);
});
