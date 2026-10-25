// SW-91: the teardown handoff must not commit untracked files (build output or
// caches a container wrote into the worktree that .gitignore misses).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { commitAndPush, removeWorkspace } from "./dist/sandbox.js";

const ident = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) =>
  execFileSync("git", [...ident, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});

/** A clone on `u/ws` with a tracked edit and an untracked cache file; origin has only `main`. */
function worktree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  const origin = path.join(tmp, "origin.git");
  git(tmp, "init", "--bare", "-b", "main", origin);
  const wt = path.join(tmp, "ws");
  git(tmp, "clone", "-q", origin, wt);
  fs.writeFileSync(path.join(wt, "tracked.txt"), "1");
  git(wt, "add", "tracked.txt");
  git(wt, "commit", "-qm", "base");
  git(wt, "push", "-q", "origin", "main");
  git(wt, "checkout", "-qb", "u/ws");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "2");
  fs.mkdirSync(path.join(wt, "cache", "deps"), { recursive: true });
  fs.writeFileSync(path.join(wt, "cache", "deps", "chunk.js"), "generated");
  return { origin, wt, keepDir: path.join(tmp, "keep") };
}

const handoff = (wt, opts) =>
  withReporter(collectingReporter(), () => commitAndPush(wt, undefined, [], opts));

test("the handoff commits tracked changes and keeps untracked files off the branch", async () => {
  const { origin, wt, keepDir } = worktree();
  const r = await handoff(wt, { keepDir });
  assert.equal(r.ok, true, r.message);

  assert.deepEqual(git(wt, "show", "--name-only", "--format=", "HEAD").split("\n"), [
    "tracked.txt",
  ]);
  assert.match(git(origin, "branch", "--list"), /u\/ws/);
  assert.match(r.message, /^ws: pushed u\/ws$/m);
  assert.match(r.message, /tracked\.txt \| 2 \+-/, "the commit's --stat");
  const tgz = path.join(keepDir, "ws.tgz");
  assert.ok(
    r.message.includes(`1 untracked file(s) left off the branch, kept in ${tgz}:`),
    r.message,
  );
  assert.match(r.message, /^ {4}cache\/deps\/chunk\.js$/m);
  assert.deepEqual(tarList(tgz), ["cache/deps/chunk.js"]);
});

test("push: false commits locally, keeps the commit as a patch, and pushes nothing", async () => {
  const { origin, wt, keepDir } = worktree();
  const r = await handoff(wt, { keepDir, push: false });
  assert.equal(r.ok, true, r.message);

  assert.equal(git(origin, "branch", "--list", "u/ws"), "");
  assert.match(r.message, /^ws: not pushed \(abandoned, no commits of its own\)/);
  const patch = fs.readFileSync(path.join(keepDir, "ws.patch"), "utf8");
  assert.match(patch, /^\+\+\+ b\/tracked\.txt$/m);
  assert.doesNotMatch(patch, /chunk\.js/);
  assert.deepEqual(tarList(path.join(keepDir, "ws.tgz")), ["cache/deps/chunk.js"]);
});

test("removeWorkspace --abandon: closeout.md rides the record branch; a handoff-only code branch stays local", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-rm-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.yaml"), `paths: { workspaces_root: ${tmp}/ws }\n`);
  const env = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "config.yaml");
  try {
    const recordOrigin = path.join(tmp, "record.git");
    git(tmp, "init", "--bare", "-q", recordOrigin);
    const ws = path.join(tmp, "ws", "fx");
    fs.mkdirSync(ws, { recursive: true });
    git(ws, "init", "-q", "-b", "u/fx");
    git(ws, "remote", "add", "origin", recordOrigin);
    fs.writeFileSync(path.join(ws, ".gitignore"), "/sandbox/\n");
    git(ws, "add", ".gitignore");
    git(ws, "commit", "-qm", "init record");
    fs.writeFileSync(path.join(ws, "closeout.md"), "# Close-out\n");
    fs.writeFileSync(path.join(ws, "note.md"), "never added");

    const code = worktree();
    fs.renameSync(code.wt, path.join(ws, "sandbox"));

    const r = await withReporter(collectingReporter(), () =>
      removeWorkspace("fx", { closedOut: true, abandon: "throwaway" }),
    );

    assert.deepEqual(git(recordOrigin, "show", "--name-only", "--format=", "u/fx").split("\n"), [
      "closeout.md",
    ]);
    assert.equal(
      git(code.origin, "branch", "--list", "u/ws"),
      "",
      "handoff-only branch not pushed",
    );
    const keep = path.join(home, "handoff", "fx");
    assert.deepEqual(tarList(path.join(keep, "fx.tgz")), ["note.md"]);
    assert.ok(fs.existsSync(path.join(keep, "sandbox.patch")));
    assert.match(r.output, /^sandbox: not pushed \(abandoned, no commits of its own\)/m);
    assert.ok(!fs.existsSync(ws), "workspace deleted");
  } finally {
    if (env === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = env;
  }
});

function tarList(tgz) {
  return execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).trim().split("\n");
}
