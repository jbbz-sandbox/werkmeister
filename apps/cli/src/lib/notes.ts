/**
 * Workspace notes — the `.sandbox/notes/` layer (jit-notes-and-handoffs-spec.md §4.1,
 * conventions in docs/notes-conventions.md).
 *
 * One note per file, `NNN-<type>-<slug>.md`, YAML frontmatter carrying
 * type / phase / author / refs / status. This module owns the shared read/write
 * plumbing: directory resolution, sequence numbering, frontmatter parsing, and the
 * type/status filters used by readers (`sandbox down` printing, tests).
 *
 * Generators never write note *content* here — the two sanctioned writers in the CLI
 * are init_workspace's legacy CLAUDE.md `## Handoff Notes` salvage and its one-time
 * starting-prompt handoff seed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

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
      numbers.push(parseInt(m.groups!["number"], 10));
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

/** Python `str.split(sep, 2)` — at most 3 parts, remainder kept intact. */
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
 * (spec §4.6: printing failures never block teardown).
 */
export function parseNote(notePath: string): Note | null {
  const match = _FILENAME_RE.exec(path.basename(notePath));
  if (!match) {
    return null;
  }
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
    number: parseInt(match.groups!["number"], 10),
    type: frontmatter["type"] ?? match.groups!["type"],
    slug: match.groups!["slug"],
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
    notes = notes.filter(
      (n) => !["superseded", "graduated"].includes(n.frontmatter["status"]),
    );
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
