// Smoke test for commitAndPush (the workspace-teardown "handoff"): a clean
// worktree that is merely BEHIND its remote base branch must be skipped (not
// fail the teardown on a non-fast-forward push), while genuinely un-pushed work
// must still be pushed. Regression for: Remove button failing because a repo
// left on `main` (behind origin) blocked the whole removal.
//   npm run build && node lib/commit-push.smoke.mjs
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpush-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
// Process-wide so commitAndPush's own commits have an identity too; containers have no ~/.gitconfig.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
});
const commit = (cwd, file, msg) => {
  fs.writeFileSync(path.join(cwd, file), msg);
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-m", msg], { cwd });
};

// Bare "origin" + a source clone that owns `main` with two commits.
const origin = path.join(tmp, "origin.git");
execFileSync("git", ["init", "--bare", "-b", "main", origin]);
const src = path.join(tmp, "src");
execFileSync("git", ["clone", origin, src], { stdio: "pipe" });
commit(src, "a.txt", "c1");
commit(src, "a.txt", "c2");
execFileSync("git", ["push", "origin", "main"], { cwd: src });

const { commitAndPush } = await import("sandbox-core");

// Case 1 (the bug): a worktree on `main` reset one commit BEHIND origin/main,
// clean tree. Nothing to hand off → must return ok WITHOUT pushing.
const behind = path.join(tmp, "behind");
execFileSync("git", ["clone", origin, behind], { stdio: "pipe" });
git(behind, "reset", "--hard", "HEAD~1"); // now behind origin/main, clean
const r1 = await commitAndPush(behind);
assert.equal(r1.ok, true, `behind-main must be skipped, got: ${r1.message}`);
assert.match(r1.message, /nothing to hand off/, "skip message");
console.log("✓ clean checkout behind origin/main → skipped (ok), no push attempted");

// Case 2 (must still work): a new feature branch with a local-only commit gets
// committed + pushed; the remote gains the branch.
const feat = path.join(tmp, "feat");
execFileSync("git", ["clone", origin, feat], { stdio: "pipe" });
git(feat, "checkout", "-b", "dev/feature-x");
fs.writeFileSync(path.join(feat, "b.txt"), "work"); // uncommitted → handoff must commit it
const r2 = await commitAndPush(feat);
assert.equal(r2.ok, true, `feature push must succeed, got: ${r2.message}`);
const remoteBranches = git(origin, "branch", "--list");
assert.match(remoteBranches, /dev\/feature-x/, "feature branch reached origin");
console.log("✓ new feature branch with local work → committed + pushed to origin");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL PASS");
process.exit(0);
