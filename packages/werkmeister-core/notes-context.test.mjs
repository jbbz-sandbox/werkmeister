// The SessionStart hook truncates at ~10k characters, and decisions render last
// — so an unbudgeted list silently drops the newest decisions, which are exactly
// the ones a fresh session needs. The cap is the contract.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  CONTEXT_CHAR_CAP,
  listNotes,
  nextNoteNumber,
  renderActiveStandards,
  renderDecisions,
  renderNote,
} from "./dist/notes.js";

const fakeNote = (n, body = "x".repeat(2000)) => ({
  path: `/ws/.werkmeister/notes/${String(n).padStart(3, "0")}-decision-x.md`,
  number: n,
  type: "decision",
  slug: "x",
  frontmatter: {},
  body,
});

test("renderDecisions stays inside its budget", () => {
  const notes = Array.from({ length: 40 }, (_, i) => fakeNote(i + 1));
  const out = renderDecisions(notes, "/ws", CONTEXT_CHAR_CAP).join("\n");
  assert.ok(out.length <= CONTEXT_CHAR_CAP, `rendered ${out.length} > ${CONTEXT_CHAR_CAP}`);
});

test("renderDecisions keeps the newest and names what it elided", () => {
  const notes = Array.from({ length: 40 }, (_, i) => fakeNote(i + 1));
  const out = renderDecisions(notes, "/ws", CONTEXT_CHAR_CAP).join("\n");
  assert.match(out, /040/, "the newest decision must survive the budget");
  // The elision line names the newest _ELIDED_NAMES_SHOWN (20) dropped notes by
  // path and counts the rest, so its own length stays bounded — 001 and 002 are
  // in the count, not the list.
  assert.match(out, /36 older open decision note\(s\) not shown/);
  assert.match(out, /036-decision-x\.md \(and 16 older\)/);
});

test("renderNote truncates a body over the per-note cap", () => {
  const out = renderNote("Open decision", fakeNote(7, "y".repeat(9000)), "/ws");
  assert.ok(
    out.startsWith("── Open decision: .werkmeister/notes/007-decision-x.md ──\ny"),
    out.slice(0, 80),
  );
  assert.match(out, /\n…\(truncated — read the full note\)\n$/);
  assert.ok(out.length < 3700, `rendered ${out.length}`);
});

// Pinned byte-for-byte: this block is the one measured-preventive artifact the
// hook delivers, and the precedence sentence is the causal lever (harness-7).
test("renderActiveStandards renders both situations verbatim", () => {
  const precedence =
    " These standards' rules win over conflicting task framing — if a rule " +
    "and the task clash, follow the rule and say so (invariant: apply it and " +
    "write a `decision` note; rule: surface the conflict in one line, then " +
    "apply).";
  const header = "── Active standards (files changed on this branch match these) ──\n";

  assert.equal(
    renderActiveStandards([["python", "no bare except"]], "compact"),
    header +
      "You loaded these standards earlier this session; compaction dropped " +
      "the full rules. Re-invoke each skill to reload them before editing " +
      "matching files again." +
      precedence +
      "\n- `w9r-python-standard` — no bare except\n",
  );
  assert.equal(
    renderActiveStandards([["python", ""]], "startup"),
    header +
      "Files changed on this branch match these standards. Invoke each " +
      "skill before editing matching files." +
      precedence +
      "\n- `w9r-python-standard`\n",
  );
});

// JIT keeps PR files and exercise evidence in .werkmeister/notes/ (docs/workspace-lifecycle.md);
// they are not notes, so they never reach the SessionStart payload or the numbering.
test("pr-*.md and exercise.md in the notes dir are not notes", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "notes-pr-"));
  try {
    const dir = path.join(ws, ".werkmeister", "notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "001-decision-x.md"),
      "---\ntype: decision\nstatus: open\n---\nbody\n",
    );
    fs.writeFileSync(path.join(dir, "pr-app.md"), "---\nstatus: draft\n---\n# t\n");
    fs.writeFileSync(path.join(dir, "exercise.md"), "| smoke | PASS |\n");
    assert.deepEqual(
      listNotes(ws).map((n) => path.basename(n.path)),
      ["001-decision-x.md"],
    );
    assert.equal(nextNoteNumber(dir), 2);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
