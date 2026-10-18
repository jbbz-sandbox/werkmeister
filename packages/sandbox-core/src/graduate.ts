/**
 * Decision-note → standards-tree graduation
 * (docs/jit-context-system.md §3.2).
 *
 * Pure mechanics: scaffold placeholder content and wire the structural links a
 * domain's STANDARD.md needs. No prose judgment (that's `sb-author`, a skill)
 * and no interactive prompting (that's the CLI layer in `commands/notes`).
 *
 * Graduation straddles two repos — the scaffold lands in the standards tree,
 * the note lives in the workspace — and nothing makes those one transaction.
 * So it doesn't pretend to be one: the note is marked `graduating` and only
 * becomes `graduated` once the scaffold is actually tracked (see
 * `reconcileGraduating`).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { dotDir } from "./config.js";
import { SandboxError } from "./errors.js";
import { standardsDirPath } from "./global_config.js";
import { listNotes, type Note } from "./notes.js";
import { run } from "./proc.js";
import { fnmatch, loadStandardsModules } from "./standards.js";

const _GIT_TIMEOUT = 5; // seconds; this can run from a SessionStart path

export const KINDS: readonly string[] = ["rule", "example", "anti-pattern"];

const _GOING_DEEPER_HEADER = "## Going deeper\n| When you're doing | Read |\n|---|---|\n";

/** Raised for any graduateNote() precondition failure. */
export class GraduationError extends SandboxError {
  constructor(message: string) {
    super(message, "GRADUATION");
    this.name = "GraduationError";
  }
}

/**
 * Refuse to graduate into a tree this machine can only read.
 *
 * `overrides.standards_dir` can point at a shared clone, a packaged tree, or
 * someone else's repo, and graduation writes *into* it. Checked as a
 * precondition rather than left to the write itself: `sandbox down` reports a
 * GraduationError but swallows anything else so teardown is never blocked, so
 * an EACCES escaping from writeFileSync would present as a graduation that
 * quietly did nothing.
 *
 * Probes *target* when it exists and its parent otherwise — an in-place rewrite
 * needs the file writable, a new reference needs the directory that will hold
 * it. Checking the tree root instead would refuse rewrites that would succeed.
 */
function requireWritable(target: string, standardsDir: string): void {
  try {
    fs.accessSync(fs.existsSync(target) ? target : path.dirname(target), fs.constants.W_OK);
  } catch {
    throw new GraduationError(
      `cannot write ${target} — graduation scaffolds into the standards tree ` +
        `(${standardsDir}), so \`overrides.standards_dir\` must name one you can write`,
    );
  }
}

/**
 * Insert *line* as the last content line of the `marker` (`"## X"`) section,
 * right before the next `## ` heading or EOF.
 *
 * If the section doesn't exist: append a new section with *headerIfMissing*
 * first (used for `## Going deeper`, which the content model says is added
 * "when they have references" — i.e. lazily, by this function). If
 * *headerIfMissing* is null, the section is required to already exist
 * (`## Rules`/`## Don't` on an eligible domain always do) and its absence
 * throws.
 */
function insertAtSectionEnd(
  body: string,
  marker: string,
  line: string,
  headerIfMissing: string | null = null,
): string {
  if (!body.includes(marker)) {
    if (headerIfMissing === null) {
      throw new GraduationError(`STANDARD.md has no '${marker}' section`);
    }
    return body.replace(/\n+$/, "") + "\n\n" + headerIfMissing + line + "\n";
  }
  const idx = body.indexOf(marker);
  const rest = body.slice(idx);
  const nextRel = rest.indexOf("\n## ", 1);
  const boundary = nextRel !== -1 ? idx + nextRel : body.length;
  const head = body.slice(0, boundary).replace(/\n+$/, "");
  const tail = body.slice(boundary).replace(/^\n+/, "");
  const sep = tail ? "\n\n" : "\n";
  return `${head}\n${line}${sep}${tail}`;
}

/**
 * Domains already in the Rules/Don't/Going-deeper shape (docs/jit-context-system.md §3.2).
 *
 * Computed from the content shape, not a fixed list: a domain is eligible
 * once its STANDARD.md carries both `## Rules` and `## Don't`. Today that's
 * service/auth/config/observability/testing (the pain-driven domains from the
 * 2026-07-17 service-merge work); comments/data/ui were directory-migrated
 * with content unchanged and don't carry the shape yet.
 */
export function eligibleDomains(modules: Record<string, Record<string, any>>): string[] {
  const result: string[] = [];
  for (const [domain, meta] of Object.entries(modules)) {
    const body = fs.readFileSync(meta["path"], "utf8");
    if (body.includes("## Rules") && body.includes("## Don't")) {
      result.push(domain);
    }
  }
  return result.sort();
}

/**
 * Match a decision note's `refs` (file paths or free-text domain mentions —
 * sb-review's capture template doesn't guarantee domain keys) against each
 * candidate domain's `applies_to` glob list, or the domain key itself.
 */
export function matchDomainsForRefs(
  refs: string[],
  modules: Record<string, Record<string, any>>,
  candidates?: string[] | null,
): string[] {
  const pool = candidates !== undefined && candidates !== null ? candidates : Object.keys(modules);
  const matched = new Set<string>();
  for (const ref of refs) {
    for (const domain of pool) {
      if (ref === domain) {
        matched.add(domain);
        continue;
      }
      for (const pattern of modules[domain]["applies_to"] ?? []) {
        if (fnmatch(ref, pattern)) {
          matched.add(domain);
          break;
        }
      }
    }
  }
  return [...matched].sort();
}

/** Rewrite frontmatter fields on a note file; body is preserved exactly. Also used for PR files (pr_lifecycle.ts). */
export function updateNoteStatus(
  notePath: string,
  fields: Record<string, string | undefined>,
): void {
  const text = fs.readFileSync(notePath, "utf8");
  // Split on the first two "---" only: the frontmatter is between them and
  // everything after the second is body (further "---" left intact).
  const i1 = text.indexOf("---");
  const i2 = text.indexOf("---", i1 + 3);
  const fmText = text.slice(i1 + 3, i2);
  const rest = text.slice(i2 + 3);
  const frontmatter: Record<string, any> = YAML.parse(fmText) ?? {};
  Object.assign(frontmatter, fields);
  const newFm = YAML.stringify(frontmatter);
  fs.writeFileSync(notePath, `---\n${newFm}---${rest}`);
}

/**
 * Close out `graduating` notes whose scaffold has actually landed.
 *
 * "Landed" means git tracks the file in the standards tree — staged or
 * committed, not merely written. That is the cheapest signal that the second,
 * human half of the graduation happened, and it is the one that distinguishes
 * "scaffold sitting untracked in someone's working copy" from "this rule is
 * real now".
 *
 * Returns the notes it closed. Silent and best-effort: a standards tree that is
 * not a git checkout leaves every note `graduating`, which is the honest answer
 * — nothing can confirm the rule landed, so nothing claims it did.
 */
export function reconcileGraduating(workspaceRoot: string, standardsDir?: string | null): Note[] {
  const pending = listNotes(workspaceRoot).filter(
    (n) => n.frontmatter["status"] === "graduating" && n.frontmatter["graduated_to"],
  );
  // The common case is no pending graduation; don't spawn git to learn that.
  if (!pending.length) {
    return [];
  }
  const dir = standardsDir ?? standardsDirPath();
  const closed: Note[] = [];
  for (const note of pending) {
    const rel = String(note.frontmatter["graduated_to"]);
    let tracked = false;
    try {
      tracked =
        run(["git", "-C", dir, "ls-files", "--error-unmatch", rel], {
          capture: true,
          timeout: _GIT_TIMEOUT,
        }).status === 0;
    } catch {
      tracked = false;
    }
    if (tracked) {
      updateNoteStatus(note.path, { status: "graduated" });
      closed.push(note);
    }
  }
  return closed;
}

export interface GraduateNoteOptions {
  domain: string;
  kind: string;
  slug?: string | null;
  standardsDir?: string | null;
}

/**
 * Scaffold *note* (a `lib/notes.parseNote()` dict) into *domain*.
 *
 * `domain` and `kind` must already be resolved by the caller — this
 * function only validates and writes; it never prompts.
 */
export function graduateNote(
  workspaceRoot: string,
  note: Record<string, any>,
  { domain, kind, slug = null, standardsDir = null }: GraduateNoteOptions,
): Record<string, any> {
  if (note["type"] !== "decision") {
    throw new GraduationError(`note ${path.basename(note["path"])} is not a decision note`);
  }
  const status = note["frontmatter"]["status"];
  if (status === "graduated" || status === "superseded") {
    throw new GraduationError(`note ${path.basename(note["path"])} is already ${status}`);
  }
  if (!KINDS.includes(kind)) {
    throw new GraduationError(
      `unknown kind '${kind}' (expected one of ('rule', 'example', 'anti-pattern'))`,
    );
  }

  if (standardsDir === undefined || standardsDir === null) {
    standardsDir = standardsDirPath();
  }
  const modules = loadStandardsModules(standardsDir);
  if (!(domain in modules)) {
    throw new GraduationError(`no \`${domain}\` module in the standards tree`);
  }
  if (!eligibleDomains(modules).includes(domain)) {
    throw new GraduationError(
      `'${domain}' hasn't been migrated to the Rules/Don't/Going-deeper ` +
        `shape yet — that's separate content work, not this pipeline's job`,
    );
  }

  const meta = modules[domain];
  const standardPath = meta["path"] as string;
  let body = fs.readFileSync(standardPath, "utf8");

  const resolvedSlug = slug || note["slug"];
  const noteRef = `${path.basename(dotDir(workspaceRoot))}/notes/${path.basename(note["path"])}`;
  const marker = `<!-- TODO(graduate): fill from note ${String(note["number"]).padStart(3, "0")}, see ${noteRef} -->`;

  let scaffoldPath: string;
  if (kind === "rule") {
    requireWritable(standardPath, standardsDir);
    const bullet = `- **TODO(graduate)** — ${marker}`;
    body = insertAtSectionEnd(body, "## Rules", bullet);
    fs.writeFileSync(standardPath, body);
    scaffoldPath = standardPath;
  } else {
    const prefix = kind === "anti-pattern" ? "ap-" : "";
    const filename = `${prefix}${resolvedSlug}.md`;
    const refsDir = path.join(path.dirname(standardPath), "references");
    requireWritable(refsDir, standardsDir);
    fs.mkdirSync(refsDir, { recursive: true });
    scaffoldPath = path.join(refsDir, filename);
    if (fs.existsSync(scaffoldPath)) {
      throw new GraduationError(`${scaffoldPath} already exists`);
    }

    if (kind === "example") {
      fs.writeFileSync(
        scaffoldPath,
        "---\n" +
          "kind: example\n" +
          "canonical: TODO\n" +
          "---\n\n" +
          "# TODO: title\n\n" +
          "## The load-bearing part\n\n" +
          `${marker}\n`,
      );
    } else {
      // anti-pattern
      fs.writeFileSync(
        scaffoldPath,
        "---\n" +
          "kind: anti-pattern\n" +
          "---\n\n" +
          "# TODO: title\n\n" +
          "## What it looks like\n\n" +
          `${marker}\n\n` +
          "## Why it's wrong\n\n" +
          `${marker}\n\n` +
          "## The fix\n\n" +
          `${marker}\n`,
      );
      const dontBullet = `- Don't TODO(graduate) — [references/${filename}](references/${filename})`;
      body = insertAtSectionEnd(body, "## Don't", dontBullet);
    }

    const row = `| TODO(graduate) | [references/${filename}](references/${filename}) |`;
    body = insertAtSectionEnd(body, "## Going deeper", row, _GOING_DEEPER_HEADER);
    fs.writeFileSync(standardPath, body);
  }

  // `graduating`, not `graduated`: the scaffold is written but uncommitted, and
  // since the standards tree is its own repo that commit is a separate act in a
  // separate place. Claiming the note is done here is how a graduation
  // half-lands — scaffold on disk, note closed, nothing ever pushed.
  // `reconcileGraduating` closes it for real once the file is tracked; until
  // then the note keeps surfacing as an open decision, which is the point.
  const graduatedTo = path.relative(standardsDir, scaffoldPath);
  updateNoteStatus(note["path"], { status: "graduating", graduated_to: graduatedTo });

  return {
    standard_path: standardPath,
    scaffold_path: scaffoldPath,
    note_path: note["path"],
    graduated_to: graduatedTo,
  };
}
