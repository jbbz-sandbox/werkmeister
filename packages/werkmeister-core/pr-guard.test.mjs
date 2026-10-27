// The PR guard is the one layer that holds whichever skill fires: inside a
// workspace, `gh pr create` and the GitHub MCP's create tool are denied.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { decide, findRecordRoot, opensPr } from "./dist/pr_guard.js";

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pr-guard-"));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), "feature: f\n");
  fs.mkdirSync(path.join(ws, "stages", "04_propose", "output"), { recursive: true });
  // A code worktree carries its own .werkmeister/ (the registry fragment).
  fs.mkdirSync(path.join(ws, "app", ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(ws, "app", ".werkmeister", "services.yaml"), "services: {}\n");
  return ws;
}

const bash = (cwd, command) => ({ cwd, tool_name: "Bash", tool_input: { command } });

test("findRecordRoot skips a code worktree's own .werkmeister/", () => {
  const ws = workspace();
  try {
    assert.equal(findRecordRoot(path.join(ws, "app")), ws);
    assert.equal(findRecordRoot(os.tmpdir()), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("denies gh pr create from the root and from a code worktree, pointing at werkmeister pr open", () => {
  const ws = workspace();
  try {
    for (const cwd of [ws, path.join(ws, "app")]) {
      const reason = decide(bash(cwd, 'cd app && gh pr create --title "x" --body y'));
      assert.match(reason ?? "", /only through `werkmeister pr open`/);
      assert.match(reason, /`stages\/04_propose\/output\/`/);
      assert.match(
        reason,
        /Rules: `docs\/workspace-lifecycle\.md in the werkmeister repo`/,
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

test("a spike's deny names its last stage's output (SW-83)", () => {
  const ws = workspace();
  try {
    fs.rmSync(path.join(ws, "stages", "04_propose"), { recursive: true });
    fs.mkdirSync(path.join(ws, "stages", "01_questions"));
    fs.mkdirSync(path.join(ws, "stages", "02_findings"));
    assert.match(decide(bash(ws, "gh pr create")) ?? "", /`stages\/02_findings\/output\/`/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("opensPr: a real invocation at a statement start (SW-83)", () => {
  for (const cmd of [
    "gh pr create",
    'cd app && gh pr create --title "x" --body y',
    "GH_TOKEN=x gh pr create --fill",
    "env GH_TOKEN=x gh pr create",
    "(cd app; gh pr create)",
    "url=$(gh pr create --fill)",
    "git push || gh pr create",
    "  gh  pr  create",
    "if true; then gh pr create; fi",
    "cat <<'EOF' > notes.md\ngh pr create\nEOF\ngh pr create --fill",
    "cat <<EOF\nEOF\ngh pr create",
    "cat <<<x; gh pr create",
  ])
    assert.equal(opensPr(cmd), true, cmd);
});

test("opensPr: the phrase in quotes, a heredoc body or a pattern is not a call (SW-83)", () => {
  for (const cmd of [
    'gh issue create --title t --body "the guard blocks gh pr create in quotes"',
    "gh issue create --body 'run gh pr create; it fails'",
    "gh issue create --body-file - <<'EOF'\nThe PR guard matched:\ngh pr create\nEOF",
    "cat <<-EOF > x.md\n\tgh pr create\n\tEOF",
    'grep -rn "gh pr create" src',
    "echo 'gh pr create' | wc -c",
    'echo "a \\" gh pr create"',
    "gh pr view 9 && gh pr list",
    "sandbox pr open",
  ])
    assert.equal(opensPr(cmd), false, cmd);
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
