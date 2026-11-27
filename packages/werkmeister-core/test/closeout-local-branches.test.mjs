// SW-1134: removing a workspace deletes its local <user>/<workspace> branch in each source clone,
// once the handoff has pushed it (or, abandoned with no commits of its own, had nothing to push).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { closeOut, openPrs, refreshPrStatus } from "../dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

for (const own of [0, 1]) {
  test(`abandon with ${own} commit(s) of its own leaves no local workspace branch in the source clone`, async () => {
    await withFixtureWorkspace(
      async (fx) => {
        await withReporter(collectingReporter(), () =>
          initWorkspace({}, fx.workspace, { build: false }),
        );
        const branch = `${os.userInfo().username}/demo`;
        const source = path.join(fx.root, "repos", path.basename(fx.repo));
        if (own) {
          fs.writeFileSync(path.join(fx.repo, "work.txt"), "work\n");
          git(fx.repo, "add", "work.txt");
          git(fx.repo, "commit", "-qm", "SW-2 work");
        }
        const tip = git(fx.repo, "rev-parse", "HEAD");
        assert.equal(git(source, "branch", "--list", "--format=%(refname:short)", branch), branch);
        await closeOut("demo", { abandon: "fixture probe" });
        assert.equal(git(source, "branch", "--list", "--format=%(refname:short)", branch), "");
        if (own) {
          // The commit is safe on origin before the local branch goes.
          const remote = path.join(fx.root, "remotes", "o", `${path.basename(fx.repo)}.git`);
          assert.equal(git(remote, "rev-parse", branch), tip);
        }
      },
      { worktrees: true, postmortem: true, jira: true, workspace: { issue_id: "SW-2" } },
    );
  });
}

test("abandon keeps the local branch when origin's copy was deleted (a stale tracking ref skipped the push)", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const branch = `${os.userInfo().username}/demo`;
      const source = path.join(fx.root, "repos", path.basename(fx.repo));
      const remote = path.join(fx.root, "remotes", "o", `${path.basename(fx.repo)}.git`);
      fs.writeFileSync(path.join(fx.repo, "work.txt"), "work\n");
      git(fx.repo, "add", "work.txt");
      git(fx.repo, "commit", "-qm", "SW-2 work");
      git(fx.repo, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      git(remote, "branch", "-D", branch); // the PR closed and GitHub deleted its branch
      const tip = git(fx.repo, "rev-parse", "HEAD");
      const r = await withReporter(collectingReporter(), () =>
        closeOut("demo", { abandon: "fixture probe" }),
      );
      assert.equal(git(source, "rev-parse", `refs/heads/${branch}`), tip, "the only copy is kept");
      assert.match(JSON.stringify(r), /kept: origin does not have its tip/);
    },
    { worktrees: true, postmortem: true, jira: true, workspace: { issue_id: "SW-2" } },
  );
});

test("a merged close-out deletes the local branch even when origin already auto-deleted it", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const branch = git(fx.repo, "rev-parse", "--abbrev-ref", "HEAD");
      const source = path.join(fx.root, "repos", path.basename(fx.repo));
      const remote = path.join(fx.root, "remotes", "o", `${path.basename(fx.repo)}.git`);
      const open = await openPrs(fx.workspace);
      assert.equal(open.ok, true, open.lines.join("\n"));
      await refreshPrStatus(fx.workspace);
      git(remote, "branch", "-D", branch); // GitHub's "delete branch on merge"
      await withReporter(collectingReporter(), () =>
        closeOut("demo", { skipPostmortem: "fixture" }),
      );
      assert.equal(git(source, "branch", "--list", "--format=%(refname:short)", branch), "");
    },
    { gate: true, merged: true, worktrees: true },
  );
});
