// SW-372: after a merge the code worktree can sit on a detached HEAD at main
// (its branch deleted). Clean and already on origin, it has nothing to hand
// off — close-out must pass it, not refuse with "no branch to push".

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { commitAndPush } from "./dist/sandbox.js";

const ident = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) =>
  execFileSync("git", [...ident, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** A clone detached at origin/main; origin has only `main`. */
function detached() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-detached-"));
  const origin = path.join(tmp, "origin.git");
  git(tmp, "init", "--bare", "-b", "main", origin);
  const wt = path.join(tmp, "ws");
  git(tmp, "clone", "-q", origin, wt);
  fs.writeFileSync(path.join(wt, "tracked.txt"), "1");
  git(wt, "add", "tracked.txt");
  git(wt, "commit", "-qm", "base");
  git(wt, "push", "-q", "origin", "main");
  git(wt, "checkout", "-q", "--detach", "origin/main");
  return { wt, keepDir: path.join(tmp, "keep") };
}

const handoff = (wt, opts) =>
  withReporter(collectingReporter(), () => commitAndPush(wt, undefined, [], opts));

test("a clean detached HEAD already on origin/main has nothing to hand off", async () => {
  const { wt, keepDir } = detached();
  const r = await handoff(wt, { keepDir });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /^ws: nothing to hand off \(detached HEAD, already on origin\/main\)$/);
});

test("a detached HEAD with a commit not on origin still refuses", async () => {
  const { wt, keepDir } = detached();
  fs.writeFileSync(path.join(wt, "tracked.txt"), "2");
  git(wt, "commit", "-qam", "local only");
  const r = await handoff(wt, { keepDir });
  assert.equal(r.ok, false);
  assert.match(r.message, /^ws: no branch to push \(detached HEAD/);
});

test("a detached HEAD with uncommitted changes still refuses", async () => {
  const { wt, keepDir } = detached();
  fs.writeFileSync(path.join(wt, "tracked.txt"), "2");
  const r = await handoff(wt, { keepDir });
  assert.equal(r.ok, false);
  assert.match(r.message, /^ws: no branch to push \(detached HEAD/);
});
