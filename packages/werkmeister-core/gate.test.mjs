// The CLI carried a second copy of this walk-up in commands/notes.ts, and
// commands/skills.ts imported it from there -- the one command-to-command
// import edge in the tree. Pinned here so deleting that copy is provably safe.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { decide, findWorkspaceRoot } from "./dist/gate.js";

test("findWorkspaceRoot walks up to the nearest .sandbox directory", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-")));
  const nested = path.join(root, "repo", "src");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, ".sandbox"));

  assert.equal(findWorkspaceRoot(nested), root);
  assert.equal(findWorkspaceRoot(root), root);
});

test("findWorkspaceRoot returns null when no .sandbox exists above start", () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bare-")));
  assert.equal(findWorkspaceRoot(bare), null);
});

const DECIDED = { note: "decision", status: "decided" };

function withGatedWorkspace(phaseGate, fn, { notesDir = true } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phase-gate-")));
  try {
    fs.mkdirSync(path.join(ws, ".sandbox"), { recursive: true });
    if (notesDir) fs.mkdirSync(path.join(ws, ".sandbox", "notes"));
    const manifest = { generated_by: "test", universal: [], domains: {} };
    if (phaseGate !== undefined) manifest.phase_gate = phaseGate;
    fs.writeFileSync(path.join(ws, ".sandbox", "standards.json"), JSON.stringify(manifest));
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function note(ws, name, status, eol = "\n") {
  const type = name.split("-")[1];
  const text = ["---", `type: ${type}`, `status: ${status}`, "---", "", "body", ""].join(eol);
  fs.writeFileSync(path.join(ws, ".sandbox", "notes", name), text);
}

const src = (ws) => path.join(ws, "repo", "src", "a.ts");

test("phase gate: no decision note denies, repeatedly, and writes no state", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    for (let i = 0; i < 2; i++) {
      const reason = decide(ws, "s1", src(ws));
      assert.match(reason, /^Phase gate:/);
      assert.match(reason, /`decision`/);
    }
    assert.ok(!fs.existsSync(path.join(ws, ".sandbox", ".gate")));
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
    assert.match(decide(ws, "s1", src(ws)), /^Standards gate: invoke `sb-implement`/);
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

test("phase gate: edits under .sandbox/ are never gated", () => {
  withGatedWorkspace(DECIDED, (ws) => {
    const target = path.join(ws, ".sandbox", "notes", "002-decision-y.md");
    assert.doesNotMatch(decide(ws, "s1", target) ?? "", /Phase gate/);
  });
});

test("phase gate: no phase_gate key, or null, behaves as today", () => {
  for (const gate of [undefined, null]) {
    withGatedWorkspace(gate, (ws) => {
      assert.match(decide(ws, "s1", src(ws)), /^Standards gate: invoke `sb-implement`/);
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
    fs.writeFileSync(path.join(ws, ".sandbox", "notes", "001-decision-x.md"), "no frontmatter\n");
    assert.doesNotMatch(decide(ws, "s1", src(ws)) ?? "", /Phase gate/);
  });
});
