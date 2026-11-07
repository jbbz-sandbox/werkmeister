// SW-520: a calling git (`git rebase --exec`, a hook) exports GIT_DIR,
// GIT_WORK_TREE or GIT_COMMON_DIR, and each beats `git -C <dir>`. A werkmeister
// git call made under one must still act on <dir>, never on the decoy it names.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { configureGitHooksPath } from "./dist/git_hooks.js";
import { run, runAsync } from "./dist/proc.js";
import { runCapture } from "./dist/tool_bins.js";

const VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARS.includes(k)));
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: clean, encoding: "utf8", stdio: "pipe" }).trim();

/** A repo at <tmp>/<name> with f = "committed\n" committed. */
function repo(tmp, name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "f"), "committed\n");
  git(dir, "add", "f");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

/** Run *fn* with process.env[name] = value, restored afterwards. */
function withVar(name, value, fn) {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

for (const [name, at] of [
  ["GIT_DIR", (d) => path.join(d, ".git")],
  ["GIT_WORK_TREE", (d) => d],
  ["GIT_COMMON_DIR", (d) => path.join(d, ".git")],
]) {
  test(`${name} at a decoy: config and worktree writes land on the -C repo`, async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-dir-env-")));
    try {
      const target = repo(tmp, "target");
      const decoy = repo(tmp, "decoy");
      const edit = () => {
        fs.writeFileSync(path.join(target, "f"), "edited\n");
        fs.writeFileSync(path.join(decoy, "f"), "edited\n");
      };
      const restored = () =>
        assert.equal(fs.readFileSync(path.join(target, "f"), "utf8"), "committed\n");

      // Each spawn helper in turn: run (sync), runAsync, and runCapture (childEnv).
      edit();
      withVar(name, at(decoy), () => {
        assert.equal(configureGitHooksPath(target), true);
        run(["git", "-C", target, "checkout", "--", "f"], { capture: true, check: true });
      });
      restored();
      edit();
      const saved = process.env[name];
      process.env[name] = at(decoy);
      try {
        await runAsync(["git", "-C", target, "checkout", "--", "f"], {
          capture: true,
          check: true,
        });
        restored();
        edit();
        assert.equal((await runCapture("git", ["-C", target, "checkout", "--", "f"])).code, 0);
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
      restored();

      assert.equal(git(target, "config", "--get", "core.hooksPath"), ".githooks");
      assert.throws(
        () => git(decoy, "config", "--get", "core.hooksPath"),
        "decoy config untouched",
      );
      assert.equal(
        fs.readFileSync(path.join(decoy, "f"), "utf8"),
        "edited\n",
        "decoy tree untouched",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
