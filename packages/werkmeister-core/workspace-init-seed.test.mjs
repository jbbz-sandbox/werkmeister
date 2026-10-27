// The starting prompt is the most important context a workspace carries, and
// the old write-once seed lost it whenever the first init ran before the prompt
// existed: the placeholder it wrote blocked the real one forever.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/config.js";
import { listNotes } from "./dist/notes.js";
import { seedStartingHandoff } from "./dist/strategies/jit.js";

const PLACEHOLDER = `---
type: handoff
phase: research
author: workspace-creation
refs: []
status: open
---

# Handoff: workspace creation

This workspace is a feature — invoke \`w9r-research\` first to explore and spec the work.

Seeded at workspace creation (no starting prompt was provided).
`;

function withWorkspace(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("no prompt seeds nothing, even with a work type", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "", "feature");
    assert.deepEqual(listNotes(ws, true), []);
  });
});

test("a prompt seeds one handoff carrying it", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "## Goal\nShip it", "feature");
    const notes = listNotes(ws, true);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].type, "handoff");
    assert.match(notes[0].body, /Seeded from `starting_prompt`/);
    assert.match(notes[0].body, /Ship it/);
    assert.match(notes[0].body, /invoke `w9r-research` first/);
  });
});

test("a placeholder from an older CLI is superseded when the prompt arrives", () => {
  withWorkspace((ws) => {
    const dir = path.join(dotDir(ws), "notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "001-handoff-starting-prompt.md"), PLACEHOLDER);
    seedStartingHandoff(ws, "## Goal\nShip it", "feature");
    const all = listNotes(ws, true);
    assert.equal(all.length, 2);
    assert.equal(all[0].frontmatter.status, "superseded");
    assert.match(all[1].body, /Ship it/);
    assert.equal(listNotes(ws).length, 1, "only the real handoff is live");
  });
});

test("a real handoff still blocks re-seeding", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "first", "feature");
    seedStartingHandoff(ws, "second", "feature");
    const all = listNotes(ws, true);
    assert.equal(all.length, 1);
    assert.match(all[0].body, /first/);
  });
});

test("the seeded handoff starts at the work type's first phase", () => {
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "Tidy the module", "refactor");
    const [note] = listNotes(ws, true);
    assert.equal(note.frontmatter.phase, "implement");
    assert.match(note.body, /invoke `w9r-implement` first/);
  });
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "Ship it", "feature");
    const [note] = listNotes(ws, true);
    assert.equal(note.frontmatter.phase, "research");
    assert.match(note.body, /`decision` note/);
  });
  withWorkspace((ws) => {
    seedStartingHandoff(ws, "Ship it", "   ");
    const [note] = listNotes(ws, true);
    assert.doesNotMatch(note.body, /This workspace is a/);
  });
});

test("an issue seeds the handoff even with an empty prompt, issue section first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  seedStartingHandoff(root, "", "bugfix", {
    ref: "o/r#5",
    url: null,
    title: "T",
    fetchedAt: "2026-10-11T00:00:00.000Z",
  });
  const [note] = fs.readdirSync(path.join(dotDir(root), "notes"));
  const body = fs.readFileSync(path.join(dotDir(root), "notes", note), "utf8");
  assert.match(body, /# Handoff: workspace creation\n\n## Issue\n\no\/r#5: T\./);
});
