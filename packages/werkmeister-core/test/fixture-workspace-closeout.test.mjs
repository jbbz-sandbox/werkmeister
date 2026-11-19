// SW-896: the fixture options that let a run reach pr push's and abandon's real paths: worktrees, a seeded postmortem.md, a fake Jira.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { fixturePreset } from "../dist/fixture_workspace.js";
import { startIssue } from "../dist/issue_status.js";
import { closeOut, openPrs, pushPrs } from "../dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("worktrees: pr open, then pr push sends a new commit to the fixture's bare origin", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const branch = `${os.userInfo().username}/demo`;
      assert.ok(fs.statSync(path.join(fx.repo, ".git")).isFile(), "a worktree's .git is a file");
      assert.equal(git(fx.repo, "branch", "--show-current"), branch);
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      const open = await openPrs(fx.workspace, undefined, undefined, { wait: false });
      assert.equal(open.ok, true, open.lines.join("\n"));
      fs.writeFileSync(path.join(fx.repo, "packages/lib/index.js"), "pushed\n");
      git(fx.repo, "commit", "-qam", "follow-up");
      const push = await pushPrs(fx.workspace);
      assert.equal(push.ok, true, push.lines.join("\n"));
      const remote = path.join(fx.root, "remotes/o/app.git");
      assert.equal(git(remote, "rev-parse", branch), git(fx.repo, "rev-parse", "HEAD"));
    },
    { gate: true, worktrees: true },
  );
});

test("postmortem and jira: abandon runs without --skip-postmortem and moves the Jira issue through the fake", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      await startIssue(fx.workspace);
      assert.ok(
        fx.jiraCalls.includes('POST /rest/api/2/issue/SW-2/transitions {"transition":{"id":"2"}}'),
        fx.jiraCalls.join("\n"),
      );
      const { output } = await closeOut("demo", { abandon: "fixture probe" });
      assert.match(output, /^Issue: SW-2 → Done$/m);
      // The close-out comment carries the post-mortem line only when postmortem.md exists.
      const comment = fx.jiraCalls.findLast((c) =>
        c.startsWith("POST /rest/api/2/issue/SW-2/comment "),
      );
      assert.match(comment ?? "", /Post-mortem: postmortem\.md/, fx.jiraCalls.join("\n"));
    },
    { postmortem: true, jira: true, workspace: { issue_id: "SW-2" } },
  );
});

test("worktrees refuses behind: a worktree shares its source's origin/main", () => {
  assert.throws(() => fixturePreset({ worktrees: true, behind: true }), /don't combine/);
});
