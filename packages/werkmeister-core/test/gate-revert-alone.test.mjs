// SW-1139: the gate reverts each commit of a grouped PR alone in a throwaway worktree and fails
// naming the one that conflicts; HEAD and the working tree stay as they were.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { gateTests, revertAloneCheck } from "../dist/pr_lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";
import { initWorkspace } from "../dist/workspace_init.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
// The check needs only `run`; defaultDeps() would load the machine registry.
const DEPS = {
  run: (cmd, args) =>
    new Promise((resolve) =>
      execFile(cmd, args, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
      ),
    ),
};

/** A repo on `me/demo` with a local bare origin whose main holds `f` (lines a, b, c). */
function repo() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "revert-alone-")));
  const dir = path.join(tmp, "app");
  git(tmp, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(tmp, "init", "-q", "-b", "main", "app");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "remote", "add", "origin", path.join(tmp, "origin.git"));
  fs.writeFileSync(path.join(dir, "f"), "a\nb\nc\nd\ne\nf\ng\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-q", "-b", "me/demo");
  return { tmp, dir };
}

/** Commits *subject* after replacing line *n* (1-based) of `f`, or writing *file* when given. */
function commit(dir, subject, { line, file }) {
  if (file) fs.writeFileSync(path.join(dir, file), `${subject}\n`);
  else {
    const p = path.join(dir, "f");
    const lines = fs.readFileSync(p, "utf8").split("\n");
    lines[line - 1] = subject;
    fs.writeFileSync(p, lines.join("\n"));
  }
  git(dir, "add", ".");
  git(dir, "commit", "-qm", subject);
  return git(dir, "rev-parse", "HEAD");
}

const snapshot = (dir) => ({
  head: git(dir, "rev-parse", "HEAD"),
  status: git(dir, "status", "--porcelain"),
  worktrees: git(dir, "worktree", "list", "--porcelain"),
});

test("two tickets on adjacent lines: fails naming the commit and its ticket, leaves HEAD and the tree (SW-1139)", async () => {
  const { tmp, dir } = repo();
  try {
    const first = commit(dir, "SW-1 first change", { line: 2 });
    commit(dir, "SW-2 second change", { line: 3 });
    fs.writeFileSync(path.join(dir, "untracked"), "keep\n");
    const before = snapshot(dir);
    const [ok, detail] = await revertAloneCheck(dir, "main", DEPS);
    assert.equal(ok, false);
    assert.match(
      detail,
      new RegExp(
        `^${first.slice(0, 7)} SW-1 first change does not revert alone \\(conflicts in f\\)`,
      ),
    );
    assert.doesNotMatch(detail, /SW-2 second change does not/);
    assert.match(detail, /put each ticket's tests in a file of its own/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("two tickets apart: passes and leaves HEAD and the tree (SW-1139)", async () => {
  const { tmp, dir } = repo();
  try {
    commit(dir, "SW-1 first change", { line: 1 });
    commit(dir, "SW-2 second change", { file: "g" });
    const before = snapshot(dir);
    assert.deepEqual(await revertAloneCheck(dir, "main", DEPS), [
      true,
      "each of 2 commits reverts alone",
    ]);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("one commit: nothing to check (SW-1139)", async () => {
  const { tmp, dir } = repo();
  try {
    commit(dir, "SW-1 only change", { line: 1 });
    assert.deepEqual(await revertAloneCheck(dir, "main", DEPS), [
      true,
      "fewer than 2 commits in origin/main..HEAD, nothing to check",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pr gate --tests has a revert row for a grouped workspace only (SW-1139)", async () => {
  const run = (workspace) =>
    withFixtureWorkspace(
      async (fx) => {
        await withReporter(collectingReporter(), () =>
          initWorkspace({}, fx.workspace, { build: false }),
        );
        return (await gateTests(fx.workspace)).lines.join("\n");
      },
      { gate: true, workspace },
    );
  assert.match(await run({ group: ["SW-2"], context_strategy: "icm" }), /✓ revert: /);
  assert.doesNotMatch(await run({ context_strategy: "icm" }), /revert:/);
});
