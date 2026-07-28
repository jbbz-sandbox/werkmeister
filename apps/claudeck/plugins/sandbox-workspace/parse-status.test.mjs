import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelain } from "./parse-status.mjs";

test("clean tree → all groups empty", () => {
  assert.deepEqual(parsePorcelain(""), { staged: [], changes: [], untracked: [] });
});

test("staged, unstaged, untracked", () => {
  const out = parsePorcelain("M  staged.js\n M changed.js\n?? new.txt\n");
  assert.deepEqual(out.staged, [{ file: "staged.js", badge: "M", cls: "modified" }]);
  assert.deepEqual(out.changes, [{ file: "changed.js", badge: "M", cls: "modified" }]);
  assert.deepEqual(out.untracked, [{ file: "new.txt", badge: "?", cls: "untracked" }]);
});

test("file both staged and further modified appears in staged and changes", () => {
  const out = parsePorcelain("MM both.js\n");
  assert.equal(out.staged.length, 1);
  assert.equal(out.staged[0].file, "both.js");
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].file, "both.js");
});

test("deleted staged", () => {
  const out = parsePorcelain("D  gone.js\n");
  assert.deepEqual(out.staged, [{ file: "gone.js", badge: "D", cls: "deleted" }]);
});
