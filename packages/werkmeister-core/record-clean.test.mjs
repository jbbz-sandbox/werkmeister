// SW-144: `werkmeister up` must leave a workspace's record branch clean. The
// files it writes are either ignored (slot-dependent compose, runtime state) or
// already what init-workspace wrote (settings allows).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { strategyById } from "./dist/strategies/index.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { ensureGeneratedIgnored, writeWorkspaceGitignore } from "./dist/worktrees.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("compose and runtime state are ignored; the record's own files are not", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "record-gi-"));
  try {
    execFileSync("git", ["init", "-q", ws]);
    writeWorkspaceGitignore(ws, ["sandbox"]);
    const ignored = (paths) => {
      try {
        return execFileSync("git", ["check-ignore", ...paths], { cwd: ws, encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean);
      } catch {
        return []; // exit 1: none ignored
      }
    };
    const generated = [
      "compose.yml",
      "compose.gate.yml",
      ".werkmeister/agent-state.json",
      ".werkmeister/last-exec",
      ".werkmeister/starts.json",
    ];
    assert.deepEqual(ignored(generated), generated);
    assert.deepEqual(
      ignored([
        ".claude/settings.json",
        ".werkmeister/claude-permissions.json",
        ".werkmeister/workspace.yml",
      ]),
      [],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("an older workspace gets the rules on up, and compose.yml is untracked", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "record-old-"));
  const git = (...a) => execFileSync("git", ["-C", ws, ...a], { encoding: "utf8" });
  try {
    git("init", "-q");
    fs.writeFileSync(path.join(ws, ".gitignore"), "/sandbox/\n/.env\n/.env.*\n");
    fs.writeFileSync(path.join(ws, "compose.yml"), "services: {}\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "old init");
    ensureGeneratedIgnored(ws);
    assert.equal(git("status", "--short"), " M .gitignore\nD  compose.yml\n");
    assert.ok(fs.existsSync(path.join(ws, "compose.yml")), "kept on disk");
    const gitignore = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
    ensureGeneratedIgnored(ws);
    assert.equal(fs.readFileSync(path.join(ws, ".gitignore"), "utf8"), gitignore, "idempotent");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("up's settings refresh is a no-op after a fresh init", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "record-init-"));
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "record-std-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(
      path.join(root, ".werkmeister", "workspace.yml"),
      "task: Record test\nwork_type: bug\nfeature: rec\nautonomous: true\ncontext_strategy: icm\n",
    );
    const settings = () => fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8");
    await withSandboxHome(
      async () => {
        await withReporter(collectingReporter(), () => initWorkspace({}, root));
        const afterInit = settings();
        withReporter(collectingReporter(), () => strategyById("icm").refresh(root));
        assert.equal(settings(), afterInit);
      },
      { config: `overrides:\n  standards_dir: ${std}\n` },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});
