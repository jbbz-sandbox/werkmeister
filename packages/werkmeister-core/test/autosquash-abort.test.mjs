// SW-1084: pr autosquash's only data-safety branch — a fold that stops is aborted, leaving the branch as it was.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { autosquash } from "../dist/pr_lifecycle.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("worktrees: pr autosquash aborts a fold that conflicts and leaves HEAD, the tree and no rebase behind", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const commit = (text, msg) => {
        fs.writeFileSync(path.join(fx.repo, "a.txt"), `${text}\n`);
        git(fx.repo, "add", "a.txt");
        git(fx.repo, "commit", "-qm", msg);
      };
      commit("1", "SW-1 first");
      commit("2", "SW-2 second");
      // Moved next to SW-1, this fixup's diff (2 → "1, fixed") no longer applies.
      commit("1, fixed", "fixup! SW-1 first");
      const head = git(fx.repo, "rev-parse", "HEAD");
      const tree = git(fx.repo, "rev-parse", "HEAD^{tree}");

      const r = await autosquash(fx.workspace);
      assert.equal(r.ok, false, r.lines.join("\n"));
      assert.match(r.lines[0], /^\S+: failed: the rebase stopped and was aborted/);
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), head);
      assert.equal(git(fx.repo, "rev-parse", "HEAD^{tree}"), tree);
      assert.equal(git(fx.repo, "status", "--porcelain"), "");
      const rebaseDir = path.resolve(
        fx.repo,
        git(fx.repo, "rev-parse", "--git-path", "rebase-merge"),
      );
      assert.ok(!fs.existsSync(rebaseDir), "no rebase left in progress");
    },
    { worktrees: true },
  );
});
