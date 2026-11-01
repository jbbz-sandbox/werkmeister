// SW-271: at run start each code worktree is brought up to origin's default branch.
// A branch with no commits of its own is fast-forwarded; any other is left alone
// with an "N commits behind <base>" line. Never throws.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { defaultBaseRef, syncToBase } from "./dist/worktrees.js";

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

function commit(dir, file) {
  fs.writeFileSync(path.join(dir, file), file);
  git(dir, "add", file);
  git(dir, "commit", "-qm", file);
}

/** A clone of a bare origin, which then moves 3 commits ahead of it. */
function behindBy3() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
  const origin = path.join(tmp, "origin.git");
  const seed = path.join(tmp, "seed");
  const dir = path.join(tmp, "app");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, seed);
  commit(seed, "base");
  git(seed, "push", "-q", "origin", "main");
  git(tmp, "clone", "-q", origin, dir);
  for (const f of ["n1", "n2", "n3"]) commit(seed, f);
  git(seed, "push", "-q", "origin", "main");
  return { dir, origin };
}

const head = (dir) => git(dir, "rev-parse", "HEAD");

test("no own commits: fast-forwarded to origin/main", () => {
  const { dir } = behindBy3();
  const [r] = syncToBase([{ repo: "app", dir }]);
  assert.deepEqual(r, { ok: true, text: "app: fast-forwarded 3 commits to origin/main" });
  assert.equal(head(dir), git(dir, "rev-parse", "origin/main"));
});

test("own commits: left as is with the right behind count", () => {
  const { dir } = behindBy3();
  commit(dir, "mine");
  const before = head(dir);
  const [r] = syncToBase([{ repo: "app", dir }]);
  assert.equal(head(dir), before);
  const n = Number(git(dir, "rev-list", "--count", "HEAD..origin/main"));
  assert.equal(n, 3);
  assert.deepEqual(r, {
    ok: false,
    text: `app: ${n} commits behind origin/main (has its own commits, left as is)`,
  });
});

test("already at base: one confirming line, nothing moves", () => {
  const { dir } = behindBy3();
  git(dir, "pull", "-q", "--ff-only");
  const before = head(dir);
  assert.deepEqual(syncToBase([{ repo: "app", dir }]), [{ ok: true, text: "app: at origin/main" }]);
  assert.equal(head(dir), before);
});

test("uncommitted changes: not fast-forwarded, the change survives", () => {
  const { dir } = behindBy3();
  fs.writeFileSync(path.join(dir, "wip"), "draft");
  const before = head(dir);
  const [r] = syncToBase([{ repo: "app", dir }]);
  assert.equal(head(dir), before);
  assert.equal(fs.readFileSync(path.join(dir, "wip"), "utf8"), "draft");
  assert.deepEqual(r, {
    ok: false,
    text: "app: 3 commits behind origin/main (uncommitted changes, not fast-forwarded)",
  });
});

test("fetch fails: a warning, no throw, HEAD unchanged", () => {
  const { dir, origin } = behindBy3();
  fs.rmSync(origin, { recursive: true });
  const before = head(dir);
  const [r] = syncToBase([{ repo: "app", dir }]);
  assert.equal(r.ok, false);
  assert.match(r.text, /^app: could not fetch origin \(.+\), left as is$/);
  assert.equal(head(dir), before);
});

test("defaultBaseRef still fetches and resolves origin/main after the split", () => {
  const { dir } = behindBy3();
  assert.equal(defaultBaseRef(dir), "origin/main");
  assert.equal(Number(git(dir, "rev-list", "--count", "HEAD..origin/main")), 3);
});
