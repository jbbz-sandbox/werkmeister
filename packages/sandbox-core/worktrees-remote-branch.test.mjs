// A `<user>/<workspace>` branch that exists only on origin was left by an
// earlier workspace of the same name. Cutting a fresh one from main diverges
// from it and the eventual handoff push is rejected, so createWorktree aborts
// with the way out — or, with force, deletes the remote branch first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { createWorktree } from "./dist/worktrees.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Bare origin with main + a stale `u/ws`; `src` is a fresh clone of it. */
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
  const origin = path.join(tmp, "origin.git");
  const seed = path.join(tmp, "seed");
  const src = path.join(tmp, "src");
  git(tmp, "init", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, seed);
  fs.writeFileSync(path.join(seed, "a"), "a");
  git(seed, "add", "a"); git(seed, "commit", "-qm", "base"); git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-qb", "u/ws");
  fs.writeFileSync(path.join(seed, "old"), "old work");
  git(seed, "add", "old"); git(seed, "commit", "-qm", "old handoff"); git(seed, "push", "-q", "origin", "u/ws");
  git(tmp, "clone", "-q", origin, src);
  return { tmp, origin, src, dest: path.join(tmp, "dest") };
}

const quiet = (fn) => withReporter(collectingReporter(), async () => fn());

test("a branch left on origin aborts with the resume command and the force hint", async () => {
  const { src, dest } = setup();
  const err = await quiet(() => { try { createWorktree(src, dest, "u/ws"); } catch (e) { return e; } });
  assert.match(err.message, /^src: branch 'u\/ws' already exists on origin \(last commit: \d{4}-\d\d-\d\d old handoff\)/);
  assert.ok(err.message.includes(`git -C ${src} branch u/ws origin/u/ws`), err.message);
  assert.match(err.message, /--force/);
  assert.ok(!fs.existsSync(dest));
});

test("the suggested command makes the next run land on the old branch", async () => {
  const { src, dest } = setup();
  git(src, "branch", "u/ws", "origin/u/ws");
  await quiet(() => createWorktree(src, dest, "u/ws"));
  assert.ok(fs.existsSync(path.join(dest, "old")));
});

test("force deletes the remote branch and cuts from main", async () => {
  const { src, dest } = setup();
  await quiet(() => createWorktree(src, dest, "u/ws", { force: true }));
  assert.ok(!fs.existsSync(path.join(dest, "old")));
  assert.equal(git(src, "ls-remote", "--heads", "origin", "u/ws"), "");
});
