// One create entry point: apps and plugins call createWorkspace, never provisionWorkspace.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const SKIP = new Set(["node_modules", "dist", "__tests__", ".turbo"]);

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

test("no app or plugin calls provisionWorkspace", () => {
  const hits = ["apps", "plugins"]
    .flatMap((d) => sources(path.join(REPO, d)))
    .filter((f) => /\bprovisionWorkspace\b/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(REPO, f));
  assert.deepEqual(hits, []);
});

test("the workspace skill states the one rule and the batch check", () => {
  const skill = fs.readFileSync(
    path.join(REPO, "plugins/werkmeister/skills/workspace/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /Every create goes through `createWorkspace`/);
  assert.match(skill, /\.werkmeister\/issue\.md/);
  assert.match(skill, /mcp__plugin_werkmeister_werkmeister__create-workspace-form/);
  assert.doesNotMatch(skill, /mcp__plugin_werkmeister_workspaces__/);
  assert.ok(skill.includes("grep -q '^## Issue$'"));
  assert.match(skill, /--no-distill/);
  assert.match(skill, /fails the create\*\*\s+if the issue can't be read/);
});
