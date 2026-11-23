// SW-896: the fixture options that let a run reach pr push's and abandon's real paths: worktrees, a seeded postmortem.md, a fake Jira.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { FIXTURE_BRANCH, fixturePreset } from "../dist/fixture_workspace.js";
import { startIssue } from "../dist/issue_status.js";
import { metricsPath, recordEvent } from "../dist/metrics.js";
import {
  autosquash,
  closeOut,
  openPrs,
  pushPrs,
  readPrFiles,
  writePrFields,
} from "../dist/pr_lifecycle.js";
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
      const remote = path.join(fx.root, "remotes/o/app.git");
      // What the conflict wake records (SW-890): the PR head it saw.
      writePrFields(readPrFiles(fx.workspace)[0], {
        conflict_head: git(remote, "rev-parse", branch),
      });
      fs.writeFileSync(path.join(fx.repo, "packages/lib/index.js"), "pushed\n");
      git(fx.repo, "commit", "-qam", "follow-up");
      const push = await pushPrs(fx.workspace);
      assert.equal(push.ok, true, push.lines.join("\n"));
      assert.equal(git(remote, "rev-parse", branch), git(fx.repo, "rev-parse", "HEAD"));
      assert.equal(
        readPrFiles(fx.workspace)[0].fm.conflict_head,
        git(fx.repo, "rev-parse", "HEAD"),
      );

      // SW-890: a reviewer pushes to the PR, the agent's full fetch moves origin/<branch> onto it, and pr push refuses.
      const reviewer = path.join(fx.root, "reviewer");
      git(fx.root, "clone", "-q", "--branch", branch, remote, reviewer);
      fs.writeFileSync(path.join(reviewer, "suggestion.txt"), "commit suggestion\n");
      git(reviewer, "add", "suggestion.txt");
      git(reviewer, "-c", "user.name=r", "-c", "user.email=r@x", "commit", "-qm", "suggestion");
      git(reviewer, "push", "-q", "origin", branch);
      const theirs = git(reviewer, "rev-parse", "HEAD");
      git(fx.repo, "fetch", "-q", "origin");
      git(fx.repo, "commit", "-q", "--amend", "-m", "follow-up, amended");
      const refused = await pushPrs(fx.workspace);
      assert.equal(refused.ok, false, refused.lines.join("\n"));
      assert.match(refused.lines[0], /the head the conflict wake saw/);
      assert.equal(
        git(remote, "rev-parse", branch),
        theirs,
        "the reviewer's commit is still on origin",
      );
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

// SW-911: the caller's agent bins, workspace config and issue cache never reach a fixture step, so the
// Jira fallback to `claude -p` (no --jira) hits the failing stub, never a real claude with the real Atlassian MCP.
test("the caller's CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN, WERKMEISTER_WORKSPACE_CONFIG and WERKMEISTER_CACHE_FILE are blank under the fixture", async () => {
  const { resolveClaudeBin } = await import("../dist/harness/claude/cli.js");
  const { resolveCodexBin } = await import("../dist/harness/codex/cli.js");
  const { resolveOpencodeBin } = await import("../dist/harness/opencode/session.js");
  const { toolBin } = await import("../dist/tool_bins.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caller-bins-"));
  const hits = path.join(dir, "hits");
  for (const name of ["claude", "codex", "opencode"])
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho ${name} >> "${hits}"\n`, {
      mode: 0o755,
    });
  fs.writeFileSync(path.join(dir, "workspace.yml"), "issue_id: SW-999\n");
  const caller = {
    CLAUDE_BIN: path.join(dir, "claude"),
    CODEX_BIN: path.join(dir, "codex"),
    OPENCODE_BIN: path.join(dir, "opencode"),
    WERKMEISTER_CACHE_FILE: path.join(dir, "issue-cache.json"),
    WERKMEISTER_WORKSPACE_CONFIG: path.join(dir, "workspace.yml"),
  };
  const prev = Object.fromEntries(Object.keys(caller).map((k) => [k, process.env[k]]));
  Object.assign(process.env, caller);
  try {
    await withFixtureWorkspace(
      async (fx) => {
        for (const k of Object.keys(caller)) assert.equal(process.env[k], "", k);
        const bins = [
          await resolveClaudeBin(),
          await resolveCodexBin(),
          await resolveOpencodeBin(),
        ];
        for (const bin of [...bins, toolBin("codex"), toolBin("opencode")]) {
          assert.ok(!bin.startsWith(dir), bin);
          try {
            execFileSync(bin, ["-p", "hi"], { stdio: "ignore" });
          } catch {}
        }
        await withReporter(collectingReporter(), () =>
          initWorkspace({}, fx.workspace, { build: false }),
        );
        await startIssue(fx.workspace);
        await closeOut("demo", { abandon: "fixture probe" });
      },
      { postmortem: true, workspace: { issue_id: "SW-2" } },
    );
    assert.equal(fs.existsSync(hits) ? fs.readFileSync(hits, "utf8") : "", "", "caller's bins ran");
    assert.equal(
      fs.existsSync(caller.WERKMEISTER_CACHE_FILE),
      false,
      "caller's issue cache written",
    );
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withFixtureWorkspace({ claudeBin, codexBin }) sets a fake on purpose", async () => {
  await withFixtureWorkspace(
    async () => {
      assert.equal(process.env.CLAUDE_BIN, "/fake/claude");
      assert.equal(process.env.CODEX_BIN, "/fake/codex");
    },
    { claudeBin: "/fake/claude", codexBin: "/fake/codex" },
  );
});

// SW-915: a preset that refuses must fail the test, not leave the fake Jira listening and hang the file.
test("withFixtureWorkspace with jira rejects a refused preset and closes the fake Jira", async () => {
  await assert.rejects(
    withFixtureWorkspace(() => {}, { jira: true, workspace: { bogus: 1 } }),
    /--workspace may not set bogus/,
  );
});

// SW-1059: auto mode refused both non-interactive forms of the contracts' `git rebase --autosquash`.
test("worktrees: pr autosquash folds a fixup! commit into its ticket's commit and keeps the tree", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const file = path.join(fx.repo, "first.txt");
      fs.writeFileSync(file, "first\n");
      git(fx.repo, "add", "first.txt");
      git(fx.repo, "commit", "-qm", "SW-1 first");
      const first = git(fx.repo, "rev-parse", "HEAD");
      fs.writeFileSync(path.join(fx.repo, "second.txt"), "second\n");
      git(fx.repo, "add", "second.txt");
      git(fx.repo, "commit", "-qm", "SW-2 second");
      fs.writeFileSync(file, "first, fixed\n");
      git(fx.repo, "commit", "-qa", "--fixup", first);
      const tree = git(fx.repo, "rev-parse", "HEAD^{tree}");
      const r = await autosquash(fx.workspace);
      assert.equal(r.ok, true, r.lines.join("\n"));
      assert.equal(git(fx.repo, "rev-parse", "HEAD^{tree}"), tree);
      assert.deepEqual(git(fx.repo, "log", "--format=%s", "origin/main..HEAD").split("\n"), [
        "SW-2 second",
        "SW-1 first",
      ]);
    },
    { worktrees: true },
  );
});

test("worktrees: pr autosquash refuses a dirty tree, another branch, a merge commit, a pushed branch and another name", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      const branch = git(fx.repo, "branch", "--show-current");
      const name = path.basename(fx.repo);
      const commit = (file, msg) => {
        fs.writeFileSync(path.join(fx.repo, file), `${msg}\n`);
        git(fx.repo, "add", file);
        git(fx.repo, "commit", "-qm", msg);
        return git(fx.repo, "rev-parse", "HEAD");
      };
      const first = commit("a.txt", "SW-1 first");
      commit("a2.txt", `fixup! SW-1 first`);
      const head = git(fx.repo, "rev-parse", "HEAD");
      const refused = async (pattern) => {
        const r = await autosquash(fx.workspace);
        assert.equal(r.ok, false, r.lines.join("\n"));
        assert.match(r.lines.join("\n"), pattern);
        assert.equal(git(fx.repo, "rev-parse", "HEAD"), head, "nothing rewritten");
      };

      fs.writeFileSync(path.join(fx.repo, "dirty.txt"), "x\n");
      await refused(/refused: not clean/);
      fs.rmSync(path.join(fx.repo, "dirty.txt"));

      git(fx.repo, "switch", "-q", "-c", "other");
      await refused(/refused: other is checked out, not this workspace's/);
      git(fx.repo, "switch", "-q", branch);

      const missing = await autosquash(fx.workspace, "nope");
      assert.equal(missing.ok, false);
      assert.match(missing.lines[0], /No code worktree named nope/);
      assert.equal((await autosquash(fx.workspace, name)).ok, true, "its own name runs");
      git(fx.repo, "reset", "-q", "--hard", head);

      git(fx.repo, "switch", "-q", "-c", "side", first);
      commit("side.txt", "side");
      git(fx.repo, "switch", "-q", branch);
      git(fx.repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
      const merged = git(fx.repo, "rev-parse", "HEAD");
      const m = await autosquash(fx.workspace);
      assert.match(m.lines[0], /refused: 1 merge commit/);
      assert.equal(git(fx.repo, "rev-parse", "HEAD"), merged);
      git(fx.repo, "reset", "-q", "--hard", head);

      git(fx.repo, "push", "-q", "origin", branch);
      await refused(/refused: .* is on origin, so folding it needs a force-push/);
    },
    { worktrees: true },
  );
});

// SW-1104: close-out pushes the run's own events as metrics.jsonl on the record branch.
test("close-out pushes this workspace's metrics slice on the record branch to its origin", async () => {
  await withFixtureWorkspace(
    async (fx) => {
      await withReporter(collectingReporter(), () =>
        initWorkspace({}, fx.workspace, { build: false }),
      );
      recordEvent(
        { event: "issue.start", workspace: "demo", ticket: "SW-2" },
        "2026-11-20T00:00:00.000Z",
      );
      recordEvent(
        { event: "issue.start", workspace: "other", ticket: "SW-3" },
        "2026-11-20T00:00:01.000Z",
      );
      await closeOut("demo", { abandon: "fixture probe" });
      const origin = path.join(fx.root, "remotes", "o", "ws.git");
      const pushed = git(origin, "show", `${FIXTURE_BRANCH}:metrics.jsonl`).split("\n");
      assert.deepEqual(
        pushed.map((l) => [JSON.parse(l).workspace, JSON.parse(l).event]),
        [["demo", "issue.start"]],
      );
      assert.ok(
        metricsPath("2026-11-20T00:00:00.000Z").startsWith(fx.root),
        "the log is under the fixture",
      );
    },
    { postmortem: true, jira: true, workspace: { issue_id: "SW-2" } },
  );
});
