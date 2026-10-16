// The PR guard is the one layer that holds whichever skill fires: inside a
// workspace, `gh pr create` and the GitHub MCP's create tool are denied.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { decide, findRecordRoot } from "./dist/pr_guard.js";

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-"));
  fs.mkdirSync(path.join(ws, ".sandbox"));
  fs.writeFileSync(path.join(ws, ".sandbox", "workspace.yml"), "feature: f\n");
  fs.mkdirSync(path.join(ws, "stages", "04_propose", "output"), { recursive: true });
  // A code worktree carries its own .sandbox/ (the registry fragment).
  fs.mkdirSync(path.join(ws, "app", ".sandbox"), { recursive: true });
  fs.writeFileSync(path.join(ws, "app", ".sandbox", "services.yaml"), "services: {}\n");
  return ws;
}

const bash = (cwd, command) => ({ cwd, tool_name: "Bash", tool_input: { command } });

test("findRecordRoot skips a code worktree's own .sandbox/", () => {
  const ws = workspace();
  try {
    assert.equal(findRecordRoot(path.join(ws, "app")), ws);
    assert.equal(findRecordRoot(os.tmpdir()), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("denies gh pr create from the root and from a code worktree, pointing at sandbox pr open", () => {
  const ws = workspace();
  try {
    for (const cwd of [ws, path.join(ws, "app")]) {
      const reason = decide(bash(cwd, 'cd app && gh pr create --title "x" --body y'));
      assert.match(reason ?? "", /only through `sandbox pr open`/);
      assert.match(reason, /`stages\/04_propose\/output\/`/);
      assert.match(
        reason,
        /Rules: `docs\/workspace-lifecycle\.md in the sandbox repo`/,
        "no rules file yet",
      );
    }
    fs.mkdirSync(path.join(ws, "_shared"));
    fs.writeFileSync(path.join(ws, "_shared", "pr-rules.md"), "x");
    assert.match(decide(bash(ws, "gh pr create")), /Rules: `_shared\/pr-rules\.md`/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("denies the GitHub MCP create_pull_request", () => {
  const ws = workspace();
  try {
    assert.ok(decide({ cwd: ws, tool_name: "mcp__github__create_pull_request", tool_input: {} }));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("allows other commands, and everything outside a workspace", () => {
  const ws = workspace();
  try {
    assert.equal(decide(bash(ws, "gh pr view 9 && gh pr list")), null);
    assert.equal(decide(bash(ws, "sandbox pr open")), null);
    assert.equal(decide(bash(os.tmpdir(), "gh pr create")), null);
    assert.equal(decide({}), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
