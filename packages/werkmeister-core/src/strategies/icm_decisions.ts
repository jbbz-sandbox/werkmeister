/**
 * icm's decisions (SW-72): each stage's self-check flips a `status: proposed`
 * line in its `output/` to `status: decided`, so those lines are what
 * graduation offers. One decision per heading that owns a decided line.
 *
 * State lives in `.werkmeister/graduations.yml`, keyed by decision id, never in
 * the stage output: that output is the run's record, and the next stage gates
 * on it still reading `status: decided`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { dotDir } from "../dot_dir.js";
import type { Note } from "../notes.js";
import type { DecisionSource } from "./types.js";

const DECIDED = /^status:\s*decided$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE = /^\s*(```|~~~)/;

type State = Record<string, Record<string, string>>;

function statePath(workspaceRoot: string): string {
  return path.join(dotDir(workspaceRoot), "graduations.yml");
}

function readState(workspaceRoot: string): State {
  try {
    const data = YAML.parse(fs.readFileSync(statePath(workspaceRoot), "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "decision"
  );
}

/** `stages/*\/output/*.md`, in stage then file order. */
function outputFiles(workspaceRoot: string): string[] {
  const stages = path.join(workspaceRoot, "stages");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(stages).sort();
  } catch {
    return [];
  }
  return dirs.flatMap((d) => {
    const out = path.join(stages, d, "output");
    try {
      return fs
        .readdirSync(out)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => path.join(out, f));
    } catch {
      return [];
    }
  });
}

/**
 * The decided sections of one stage output: the nearest heading above each
 * decided line, its body running to the next heading at the same or a higher
 * level. A decided line above every heading belongs to the file itself.
 * Frontmatter (`pr-*.md` carries `status: draft`) and fenced code are skipped.
 */
function decidedSections(text: string, stem: string): Array<{ slug: string; body: string }> {
  const lines = text.split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end !== -1) start = end + 1;
  }
  const headings: Array<{ at: number; level: number; title: string }> = [];
  const owners = new Set<number>(); // index into headings, -1 = the file itself
  let fenced = false;
  for (let i = start; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = HEADING.exec(lines[i]);
    if (h) headings.push({ at: i, level: h[1].length, title: h[2] });
    else if (DECIDED.test(lines[i].trim())) owners.add(headings.length - 1);
  }

  const seen = new Map<string, number>();
  return [...owners].map((idx) => {
    const own = headings[idx];
    const next = own ? headings.slice(idx + 1).find((h) => h.level <= own.level) : headings[0];
    let slug = slugify(own ? own.title : stem);
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    if (n > 1) slug = `${slug}-${n}`;
    const body = lines.slice(own ? own.at : start, next ? next.at : lines.length).join("\n");
    return { slug, body };
  });
}

/** `stages/NN_x/output/file.md#slug` — the decision's id and its key in graduations.yml. */
function decisionId(workspaceRoot: string, note: Note): string {
  return path.relative(workspaceRoot, note.path);
}

export const stageDecisions: DecisionSource = {
  open(workspaceRoot) {
    const state = readState(workspaceRoot);
    const open: Note[] = [];
    // Numbered across every decided section, graduated ones included, so a
    // decision keeps its number for `notes graduate <n>` as others close.
    let number = 0;
    for (const file of outputFiles(workspaceRoot)) {
      const sections = decidedSections(fs.readFileSync(file, "utf8"), path.basename(file, ".md"));
      for (const { slug, body } of sections) {
        number += 1;
        const note: Note = {
          path: `${file}#${slug}`,
          number,
          type: "decision",
          slug,
          frontmatter: {},
          body,
        };
        const recorded = state[decisionId(workspaceRoot, note)] ?? {};
        note.frontmatter = { type: "decision", status: "decided", refs: [], ...recorded };
        if (["graduated", "superseded"].includes(note.frontmatter["status"])) continue;
        open.push(note);
      }
    }
    return open;
  },

  mark(workspaceRoot, note, fields) {
    const state = readState(workspaceRoot);
    const id = decisionId(workspaceRoot, note);
    state[id] = { ...state[id], ...fields };
    fs.mkdirSync(dotDir(workspaceRoot), { recursive: true });
    fs.writeFileSync(statePath(workspaceRoot), YAML.stringify(state));
  },

  cite: (workspaceRoot, note) =>
    `decision ${String(note.number).padStart(3, "0")}, see ${decisionId(workspaceRoot, note)}`,
};
