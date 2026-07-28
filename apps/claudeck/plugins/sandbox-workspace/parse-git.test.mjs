import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitStatus } from "./parse-git.mjs";

test("clean branch with upstream", () => {
  const out = parseGitStatus("## jayboyer/test-me...origin/jayboyer/test-me\n");
  assert.deepEqual(out, {
    branch: "jayboyer/test-me",
    upstream: "origin/jayboyer/test-me",
    dirty: 0,
    ahead: 0,
    behind: 0,
  });
});

test("dirty count + ahead/behind", () => {
  const out = parseGitStatus(
    "## main...origin/main [ahead 2, behind 1]\n M src/a.js\n?? new.txt\n",
  );
  assert.equal(out.branch, "main");
  assert.equal(out.dirty, 2);
  assert.equal(out.ahead, 2);
  assert.equal(out.behind, 1);
});

test("branch with no upstream", () => {
  const out = parseGitStatus("## feature-x\n");
  assert.equal(out.branch, "feature-x");
  assert.equal(out.upstream, null);
  assert.equal(out.ahead, 0);
  assert.equal(out.behind, 0);
});

test("detached HEAD", () => {
  const out = parseGitStatus("## HEAD (no branch)\n M a\n");
  assert.equal(out.branch, null);
  assert.equal(out.dirty, 1);
});

test("empty input", () => {
  assert.deepEqual(parseGitStatus(""), { branch: null, upstream: null, dirty: 0, ahead: 0, behind: 0 });
});
