/**
 * Workspace notes — the `.sandbox/notes/` layer (jit-context-system.md §5.7,
 * conventions in docs/notes-conventions.md).
 *
 * One note per file, `NNN-<type>-<slug>.md`, YAML frontmatter carrying
 * type / phase / author / refs / status. This module owns the shared read/write
 * plumbing: directory resolution, sequence numbering, frontmatter parsing, and the
 * type/status filters used by readers (`sandbox down` printing, tests) — plus
 * `buildContext`, the SessionStart hook's payload, built from those same reads.
 *
 * Generators never write note *content* here — the two sanctioned writers in the CLI
 * are init_workspace's legacy CLAUDE.md `## Handoff Notes` salvage and its one-time
 * starting-prompt handoff seed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { reconcileGraduating } from "./graduate.js";
import { skillNameFor } from "./skill_gen.js";
import { standardsMatchingDiff } from "./standards.js";

export const NOTE_TYPES = ["finding", "decision", "attempt", "handoff", "contract"] as const;

const _FILENAME_RE = new RegExp(
  "^(?<number>\\d{3})-(?<type>" + NOTE_TYPES.join("|") + ")-(?<slug>[a-z0-9][a-z0-9-]*)\\.md$",
);

export interface Note {
  path: string;
  number: number;
  type: string;
  slug: string;
  frontmatter: Record<string, any>;
  body: string;
}

/** Return the workspace's notes directory (may not exist yet). */
export function notesDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".sandbox", "notes");
}

/** Return the next free NNN sequence number in *directory* (1 if empty/missing). */
export function nextNoteNumber(directory: string): number {
  if (!(fs.existsSync(directory) && fs.statSync(directory).isDirectory())) {
    return 1;
  }
  const numbers: number[] = [];
  for (const name of fs.readdirSync(directory)) {
    const m = _FILENAME_RE.exec(name);
    if (m && fs.statSync(path.join(directory, name)).isFile()) {
      numbers.push(parseInt(m[1], 10));
    }
  }
  return Math.max(0, ...numbers) + 1;
}

/** Render the canonical `NNN-<type>-<slug>.md` filename. */
export function noteFilename(number: number, noteType: string, slug: string): string {
  if (!(NOTE_TYPES as readonly string[]).includes(noteType)) {
    throw new Error(
      `unknown note type: '${noteType}' (expected one of (${NOTE_TYPES.map((t) => `'${t}'`).join(", ")}))`,
    );
  }
  return `${String(number).padStart(3, "0")}-${noteType}-${slug}.md`;
}

/** Split on the first two *sep* only — at most 3 parts, remainder kept intact. */
function _split3(text: string, sep: string): string[] {
  const first = text.indexOf(sep);
  if (first === -1) return [text];
  const second = text.indexOf(sep, first + sep.length);
  if (second === -1) return [text.slice(0, first), text.slice(first + sep.length)];
  return [
    text.slice(0, first),
    text.slice(first + sep.length, second),
    text.slice(second + sep.length),
  ];
}

/**
 * Parse one note file into `{path, number, type, slug, frontmatter, body}`.
 *
 * Returns null for files that don't match the naming convention or whose
 * frontmatter fails to parse — readers skip malformed notes rather than crash
 * (docs/jit-context-system.md §5.7: printing failures never block teardown).
 */
export function parseNote(notePath: string): Note | null {
  const match = _FILENAME_RE.exec(path.basename(notePath));
  if (!match) {
    return null;
  }
  const [, number, type, slug] = match;
  let text: string;
  try {
    text = fs.readFileSync(notePath, "utf8");
  } catch {
    return null;
  }

  let frontmatter: Record<string, any> = {};
  let body = text;
  if (text.startsWith("---")) {
    const parts = _split3(text, "---");
    if (parts.length === 3) {
      try {
        const parsed = YAML.parse(parts[1]);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          frontmatter = parsed;
          body = parts[2].replace(/^\n+/, "");
        }
      } catch {
        // malformed frontmatter — treat the whole file as body
      }
    }
  }

  return {
    path: notePath,
    number: parseInt(number, 10),
    type: frontmatter["type"] ?? type,
    slug,
    frontmatter,
    body,
  };
}

/**
 * List parsed notes in sequence order, skipping malformed files.
 *
 * `status: superseded` and `status: graduated` notes are skipped by default
 * (the reader rule in docs/notes-conventions.md).
 */
export function listNotes(workspaceRoot: string, includeSuperseded = false): Note[] {
  const directory = notesDir(workspaceRoot);
  if (!(fs.existsSync(directory) && fs.statSync(directory).isDirectory())) {
    return [];
  }
  let notes: Note[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const notePath = path.join(directory, name);
    if (!fs.statSync(notePath).isFile()) {
      continue;
    }
    const parsed = parseNote(notePath);
    if (parsed !== null) {
      notes.push(parsed);
    }
  }
  if (!includeSuperseded) {
    notes = notes.filter((n) => !["superseded", "graduated"].includes(n.frontmatter["status"]));
  }
  return notes;
}

/** Return the highest-numbered non-superseded, non-graduated handoff note, or null. */
export function latestHandoff(workspaceRoot: string): Note | null {
  const handoffs = listNotes(workspaceRoot).filter((n) => n.type === "handoff");
  return handoffs.length ? handoffs[handoffs.length - 1] : null;
}

/** Return non-superseded, non-graduated decision notes in sequence order. */
export function openDecisions(workspaceRoot: string): Note[] {
  return listNotes(workspaceRoot).filter((n) => n.type === "decision");
}

// ---------------------------------------------------------------------------
// Session-start context (the SessionStart hook's payload)
//
// Pure string builders over the notes above. The CLI's `notes context` writes
// what `buildContext` returns to stdout and adds nothing to it.
// ---------------------------------------------------------------------------

// Per-note body cap. The hook harness truncates combined output at 10k chars;
// staying under it ourselves keeps the pointer lines from being cut off.
const _BODY_CHAR_CAP = 3500;
// Total cap on what `buildContext` prints, under the same 10k truncation.
// Standards and the handoff are charged against it first and always print;
// the decision list takes what is left. The slack below 10k covers section
// separators and the "~" in the harness's ~10k.
export const CONTEXT_CHAR_CAP = 9000;
// Elided decisions named on the elision line; the rest are a count.
const _ELIDED_NAMES_SHOWN = 20;

export function renderNote(header: string, note: Note, workspace: string): string {
  const rel = path.relative(workspace, note.path);
  let body = note.body.trim();
  if (body.length > _BODY_CHAR_CAP) {
    body = body.slice(0, _BODY_CHAR_CAP) + "\n…(truncated — read the full note)";
  }
  return `── ${header}: ${rel} ──\n${body}\n`;
}

/**
 * Render open decisions into *budget* chars, keeping the newest.
 *
 * Decisions print after the handoff, so an unbounded list lost its newest
 * entries to the harness truncation — the ones a fresh session needs most.
 * Kept notes stay in sequence order; elided ones are listed by path so the
 * session can still read them.
 */
export function renderDecisions(decisions: Note[], workspace: string, budget: number): string[] {
  const rendered = decisions.map((d) => renderNote("Open decision", d, workspace));
  // The elision line counts against the budget too — otherwise it is exactly
  // what the truncation cuts — and names only the newest few dropped notes so
  // its own length stays bounded however many there are.
  const elision = (count: number): string => {
    if (count === 0) return "";
    const names = decisions.slice(0, count).map((d) => path.basename(d.path));
    const shown = names.slice(-_ELIDED_NAMES_SHOWN);
    const older = names.length - shown.length;
    return (
      `── ${count} older open decision note(s) not shown (context budget) — read them ` +
      `in .sandbox/notes/: ${shown.join(", ")}${older ? ` (and ${older} older)` : ""} ──\n`
    );
  };
  let keepFrom = rendered.length;
  let used = 0;
  while (
    keepFrom > 0 &&
    used + rendered[keepFrom - 1].length + elision(keepFrom - 1).length <= budget
  ) {
    used += rendered[keepFrom - 1].length;
    keepFrom -= 1;
  }
  const sections = rendered.slice(keepFrom);
  if (keepFrom > 0) {
    sections.push(elision(keepFrom));
  }
  return sections;
}

/**
 * Render the diff-scoped standards re-injection block.
 *
 * The precedence sentence re-delivers the framing compaction squashes —
 * harness-7 measured summary-only re-anchoring at 0/3 against a conflicting
 * task nudge even when the summary named the exact rule; precedence, not
 * summary specificity, is the causal lever.
 */
export function renderActiveStandards(pairs: Array<[string, string]>, source: string): string {
  let situation: string;
  if (source === "compact") {
    situation =
      "You loaded these standards earlier this session; compaction dropped " +
      "the full rules. Re-invoke each skill to reload them before editing " +
      "matching files again.";
  } else {
    situation =
      "Files changed on this branch match these standards. Invoke each " +
      "skill before editing matching files.";
  }
  const lines = [
    "── Active standards (files changed on this branch match these) ──",
    situation +
      " These standards' rules win over conflicting task framing — if a rule " +
      "and the task clash, follow the rule and say so (invariant: apply it and " +
      "write a `decision` note; rule: surface the conflict in one line, then " +
      "apply).",
  ];
  for (const [domain, summary] of pairs) {
    let line = `- \`${skillNameFor(domain)}\``;
    if (summary) {
      line += ` — ${summary}`;
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the session-start standards + notes context; empty when neither exists.
 *
 * Standards render first: the hook harness truncates combined output at 10k
 * chars, and with an unbounded pile of open decision notes the re-inject
 * block — the one measured-preventive artifact — must not be the part that
 * gets cut.
 */
export function buildContext(workspace: string, source = ""): string {
  // Before listing: a graduation whose scaffold has landed should not keep
  // presenting itself as an open decision at every session start.
  reconcileGraduating(workspace);
  const handoff = latestHandoff(workspace);
  const decisions = openDecisions(workspace);
  const standards = standardsMatchingDiff(workspace);
  if (handoff === null && !decisions.length && !standards.length) {
    return "";
  }

  const sections: string[] = [];
  if (standards.length) {
    sections.push(renderActiveStandards(standards, source));
  }

  if (handoff !== null || decisions.length) {
    sections.push(
      "Workspace notes exist in .sandbox/notes/ — working state that survives " +
        "sessions and compaction. `decision` notes are binding: they override " +
        "task-level instincts; if one conflicts with the task as given, raise it " +
        "to the user. Read relevant `finding`/`attempt` notes before " +
        "re-researching or re-trying an approach.\n",
    );
    if (handoff !== null) {
      sections.push(renderNote("Latest handoff", handoff, workspace));
    }
    const used = sections.join("\n").length;
    sections.push(...renderDecisions(decisions, workspace, CONTEXT_CHAR_CAP - used));
  }

  return sections.join("\n");
}
