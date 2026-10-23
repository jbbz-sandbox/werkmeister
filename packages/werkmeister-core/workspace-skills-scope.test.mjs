// A standard that is not projected cannot be loaded — the same "cannot
// misbehave" logic as the subagent tool gates, applied to the skill set.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { renderWorkspaceSkills } from "./dist/workspace_skills.js";

const MODULE = (domain) =>
  `---\ndomain: ${domain}\nsummary: ${domain} rules\napplies_to:\n  - '**/*.ts'\n---\n\n# ${domain}\n`;

function withTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-scope-"));
  try {
    for (const d of ["alpha", "beta"]) fs.writeFileSync(path.join(dir, `${d}.md`), MODULE(d));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("no active list projects every standard", () => {
  withTree((dir) => {
    const names = Object.keys(renderWorkspaceSkills(dir, null, null));
    assert.ok(names.includes("sb-alpha-standard"));
    assert.ok(names.includes("sb-beta-standard"));
  });
});

test("an active list keeps only those standards and every entry skill", () => {
  withTree((dir) => {
    const names = Object.keys(renderWorkspaceSkills(dir, null, ["alpha"]));
    assert.ok(names.includes("sb-alpha-standard"));
    assert.ok(!names.includes("sb-beta-standard"));
    assert.ok(names.includes("sb-implement"), "entry skills are never filtered");
  });
});
