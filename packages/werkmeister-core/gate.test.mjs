// The CLI carried a second copy of this walk-up in commands/notes.ts, and
// commands/skills.ts imported it from there -- the one command-to-command
// import edge in the tree. Pinned here so deleting that copy is provably safe.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { decide, findWorkspaceRoot, patchPaths } from "./dist/gate.js";

test("findWorkspaceRoot walks up to the nearest .werkmeister directory", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-")));
  const nested = path.join(root, "repo", "src");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, ".werkmeister"));

  assert.equal(findWorkspaceRoot(nested), root);
  assert.equal(findWorkspaceRoot(root), root);
});

test("findWorkspaceRoot returns null when no .werkmeister exists above start", () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bare-")));
  assert.equal(findWorkspaceRoot(bare), null);
});

// SW-113: a temp config's workspace root must hide a real workspace the CLI starts inside.
test("findWorkspaceRoot with roots ignores a workspace outside them", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roots-")));
  const real = path.join(tmp, "features", "real-ws");
  fs.mkdirSync(path.join(real, ".werkmeister"), { recursive: true });
  fs.mkdirSync(path.join(real, "sandbox", "src"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "ws"));

  assert.equal(findWorkspaceRoot(path.join(real, "sandbox", "src"), [path.join(tmp, "ws")]), null);
  assert.equal(findWorkspaceRoot(real, [path.join(tmp, "ws")]), null);
});

test("findWorkspaceRoot with roots returns the folder under the root, past a worktree's .werkmeister", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roots-")));
  const ws = path.join(root, "ws-1");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.mkdirSync(path.join(ws, "sandbox", ".werkmeister"), { recursive: true });
  fs.mkdirSync(path.join(ws, "sandbox", "src"));
  fs.mkdirSync(path.join(root, "not-a-ws"));

  assert.equal(findWorkspaceRoot(path.join(ws, "sandbox", "src"), [root]), ws);
  assert.equal(findWorkspaceRoot(ws, ["/elsewhere", root]), ws);
  assert.equal(findWorkspaceRoot(root, [root]), null);
  assert.equal(findWorkspaceRoot(path.join(root, "not-a-ws"), [root]), null);
});

// SW-285: macOS mktemp gives /var/folders/…, but process.cwd() is /private/var/folders/….
test("findWorkspaceRoot with roots matches a cwd reached through a symlinked root (SW-285)", () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roots-real-")));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const ws = path.join(real, "fx");
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  try {
    const found = findWorkspaceRoot(ws, [link]);
    assert.ok(found, "a cwd under the symlink's target is under the root");
    assert.equal(fs.realpathSync(found), ws);
  } finally {
    fs.rmSync(link);
    fs.rmSync(real, { recursive: true, force: true });
  }
});

const DECIDED = { note: "decision", status: "decided" };

function withGatedWorkspace(phaseGate, fn, { notesDir = true } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phase-gate-")));
  try {
    fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
    if (notesDir) fs.mkdirSync(path.join(ws, ".werkmeister", "notes"));
    const manifest = { generated_by: "test", universal: [], domains: {} };
    if (phaseGate !== undefined) manifest.phase_gate = phaseGate;
    fs.writeFileSync(path.join(ws, ".werkmeister", "standards.json"), JSON.stringify(manifest));
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function note(ws, name, status, eol = "\n") {
  const type = name.split("-")[1];
  const text = ["---", `type: ${type}`, `status: ${status}`, "---", "", "body", ""].join(eol);
  fs.writeFileSync(path.join(ws, ".werkmeister", "notes", name), text);
}

const src = (ws) => path.join(ws, "repo", "src", "a.ts");

test("phase gate: no decision note denies, repeatedly, and writes no state", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    for (let i = 0; i < 2; i++) {
      const reason = decide(ws, "s1", src(ws));
      assert.match(reason, /^Phase gate:/);
      assert.match(reason, /`decision`/);
    }
    assert.ok(!fs.existsSync(path.join(ws, ".werkmeister", ".gate")));
  });
});

test("phase gate: an open decision note still denies", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-x.md", "open");
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:/);
  });
});

test("phase gate: a decided note falls through to the standards gate", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-x.md", "decided");
    assert.match(decide(ws, "s1", src(ws)), /^Standards gate: invoke `w9r-implement`/);
    assert.equal(decide(ws, "s1", src(ws)), null);
  });
});

test("phase gate: a superseded note is skipped, not counted", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-old.md", "superseded");
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:/);
    note(ws, "002-decision-new.md", "decided");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

test("phase gate: edits under .werkmeister/ are never gated", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    const target = path.join(ws, ".werkmeister", "notes", "002-decision-y.md");
    assert.doesNotMatch(decide(ws, "s1", target) ?? "", /Phase gate/);
  });
});

test("phase gate: no phase_gate key, or null, behaves as today", () => {
  for (const gate of [undefined, null]) {
    withGatedWorkspace(gate, (ws) => {
      assert.match(decide(ws, "s1", src(ws)), /^Standards gate: invoke `w9r-implement`/);
    });
  }
});

test("phase gate: a finding gate accepts any live finding note", () => {
  withGatedWorkspace({ note: "finding" }, (ws) => {
    assert.match(decide(ws, "s1", src(ws)), /^Phase gate:.*`finding`/s);
    note(ws, "001-finding-root-cause.md", "open");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

// Review Focus 2: ENOENT is "no notes yet", not "unreadable".
test("phase gate: a missing notes dir still denies", () => {
  withGatedWorkspace(
    DECIDED,
    (ws) => {
      assert.match(decide(ws, "s1", src(ws)), /^Phase gate:/);
    },
    { notesDir: false },
  );
});

// Review Focus 3.
test("phase gate: a quoted status with CRLF line endings satisfies the gate", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    note(ws, "001-decision-x.md", '"decided"', "\r\n");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

// Review Focus 4.
test("phase gate: a path outside the workspace is not gated", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    const outside = path.join(path.dirname(ws), "elsewhere", "a.ts");
    assert.doesNotMatch(decide(ws, "s1", outside) ?? "", /Phase gate/);
  });
});

test("phase gate: a dot-dot-prefixed name inside the workspace is gated", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    assert.match(decide(ws, "s1", path.join(ws, "..env.ts")) ?? "", /^Phase gate:/);
  });
});

test("phase gate: a note with no frontmatter fails open", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    fs.writeFileSync(
      path.join(ws, ".werkmeister", "notes", "001-decision-x.md"),
      "no frontmatter\n",
    );
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});

// SW-189: Codex edits through apply_patch, sending the patch in tool_input.command and no file_path.
const PATCH = [
  "*** Begin Patch",
  "*** Add File: .werkmeister/notes/002-decision-y.md",
  "+x",
  "*** Update File: repo/src/a.ts",
  "*** Move to: repo/src/b.ts",
  "@@",
  "-a",
  "+b",
  "*** Delete File: repo/src/a.ts",
  "*** End Patch",
].join("\n");

test("patchPaths lists each file an apply_patch body touches, once, in order", () => {
  assert.deepEqual(patchPaths(PATCH), [
    ".werkmeister/notes/002-decision-y.md",
    "repo/src/a.ts",
    "repo/src/b.ts",
  ]);
  assert.deepEqual(patchPaths("echo hi"), []);
});

const runGate = (input) =>
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", 'import { main } from "./dist/gate.js"; main();'],
    { cwd: import.meta.dirname, input: JSON.stringify(input), encoding: "utf8" },
  );

test("gate main: a Codex apply_patch is gated on the paths in the patch, relative to cwd", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    const out = runGate({
      session_id: "s1",
      cwd: ws,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: repo/src/a.ts\n*** End Patch" },
      turn_id: "t1",
    });
    const deny = JSON.parse(out).hookSpecificOutput;
    assert.equal(deny.permissionDecision, "deny");
    // Without the patch paths the gate saw "" and skipped the phase gate.
    assert.match(deny.permissionDecisionReason, /^Phase gate:/);
  });
});
