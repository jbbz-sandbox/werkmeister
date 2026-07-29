/**
 * sandbox notes <context|graduate>
 *
 * `context`: print the workspace's notes context for injection into a fresh
 * Claude Code window — the SessionStart hook target
 * (jit-context-system.md §5.8). Output is plain text on stdout, hook-
 * safe (never raises, always exits 0).
 *
 * `graduate`: scaffold an open `decision` note into `docs/standards/`
 * (docs/jit-context-system.md §3.2). Mechanical scaffolding is
 * `graduate.ts`; this module resolves domain/kind
 * (interactively at a TTY, or via `--domain`/`--kind` flags otherwise) and is
 * reused by `sandbox down`'s teardown prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";

import { error, info, success } from "../lib/config.js";
import { resetSessionState } from "../lib/gate.js";
import {
  GraduationError,
  KINDS,
  eligibleDomains,
  graduateNote,
  matchDomainsForRefs,
} from "../lib/graduate.js";
import { latestHandoff, openDecisions, type Note } from "../lib/notes.js";
import { skillNameFor } from "../lib/skill_gen.js";
import { loadStandardsModules, standardsMatchingDiff } from "../lib/standards.js";

// Per-note body cap. The hook harness truncates combined output at 10k chars;
// staying under it ourselves keeps the pointer lines from being cut off.
const _BODY_CHAR_CAP = 3500;

/** Python `input(prompt)`: write *promptStr*, read one line (no trailing newline). */
async function input(promptStr: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(promptStr);
  } finally {
    rl.close();
  }
}

/** Python `sys.stdin.isatty()`. */
function stdinIsatty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Walk up from *start* to the nearest directory containing `.sandbox/`.
 *
 * Sessions launch from the workspace root or inside one of its repo
 * worktrees; either way the workspace is the closest ancestor with a
 * `.sandbox` directory.
 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".sandbox");
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return dir;
      }
    } catch {
      // not present here
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function renderNote(header: string, note: Note, workspace: string): string {
  const rel = path.relative(workspace, note.path);
  let body = note.body.trim();
  if (body.length > _BODY_CHAR_CAP) {
    body = body.slice(0, _BODY_CHAR_CAP) + "\n…(truncated — read the full note)";
  }
  return `── ${header}: ${rel} ──\n${body}\n`;
}

/**
 * Render the diff-scoped standards re-injection block.
 *
 * The precedence sentence re-delivers the framing compaction squashes —
 * harness-7 measured summary-only re-anchoring at 0/3 against a conflicting
 * task nudge even when the summary named the exact rule; precedence, not
 * summary specificity, is the causal lever.
 */
function renderActiveStandards(pairs: Array<[string, string]>, source: string): string {
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
    for (const d of decisions) {
      sections.push(renderNote("Open decision", d, workspace));
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// graduate
// ---------------------------------------------------------------------------

async function resolveDomain(
  note: Note,
  modules: Record<string, Record<string, any>>,
  domain: string | null,
): Promise<string> {
  const eligible = eligibleDomains(modules);
  if (domain) {
    if (!eligible.includes(domain)) {
      throw new GraduationError(
        `'${domain}' is not an eligible domain (eligible: ${eligible.join(", ")})`,
      );
    }
    return domain;
  }

  const refs = (note.frontmatter["refs"] ?? []) as string[];
  const matches = matchDomainsForRefs(refs, modules, eligible);
  if (matches.length === 1) {
    return matches[0];
  }

  if (!stdinIsatty()) {
    throw new GraduationError(
      `ambiguous or unmatched domain for note refs ${reprList(refs)} — pass --domain ` +
        `(eligible: ${eligible.join(", ")})`,
    );
  }
  console.log(`Which domain? [${eligible.join(", ")}]`);
  const choice = (await input("> ")).trim();
  if (!eligible.includes(choice)) {
    throw new GraduationError(`'${choice}' is not an eligible domain`);
  }
  return choice;
}

async function resolveKind(kind: string | null): Promise<string> {
  if (kind) {
    return kind;
  }
  if (!stdinIsatty()) {
    throw new GraduationError(`--kind required (expected one of ${reprTuple(KINDS)})`);
  }
  const choice = (await input(`Kind? [${KINDS.join("/")}] > `)).trim();
  if (!KINDS.includes(choice)) {
    throw new GraduationError(
      `'${choice}' is not a valid kind (expected one of ${reprTuple(KINDS)})`,
    );
  }
  return choice;
}

/**
 * Resolve domain/kind (interactively or via already-given values) and
 * graduate *note*. Raises GraduationError on any failure — never prompts
 * when a value is already given.
 */
async function graduateOne(
  workspace: string,
  note: Note,
  { domain, kind, slug }: { domain: string | null; kind: string | null; slug: string | null },
): Promise<Record<string, any>> {
  const modules = loadStandardsModules();
  const resolvedDomain = await resolveDomain(note, modules, domain);
  const resolvedKind = await resolveKind(kind);
  return graduateNote(workspace, note, { domain: resolvedDomain, kind: resolvedKind, slug });
}

async function runGraduate(args: Record<string, unknown>): Promise<void> {
  const workspace = findWorkspaceRoot(process.cwd());
  if (workspace === null) {
    error("Not inside a sandbox workspace (no .sandbox/ directory found above CWD).");
    process.exit(1);
  }

  const decisions = openDecisions(workspace);
  if (!decisions.length) {
    info("No open decision notes to graduate.");
    return;
  }

  let noteNum = args.note_num as number | null;
  if (noteNum === null || noteNum === undefined) {
    if (!stdinIsatty()) {
      error("Pass a note number as an argument (non-interactive mode).");
      process.exit(1);
    }
    console.log("Open decision notes:");
    for (const n of decisions) {
      console.log(`  [${String(n.number).padStart(3, "0")}] ${path.basename(n.path)}`);
    }
    const choice = (await input("Graduate which note number? > ")).trim();
    const parsed = parseIntStrict(choice);
    if (parsed === null) {
      error(`'${choice}' is not a note number.`);
      process.exit(1);
    }
    noteNum = parsed;
  }

  const note = decisions.find((n) => n.number === noteNum) ?? null;
  if (note === null) {
    error(`No open decision note numbered ${String(noteNum).padStart(3, "0")}.`);
    process.exit(1);
  }

  let result: Record<string, any>;
  try {
    result = await graduateOne(workspace, note, {
      domain: (args.domain as string | null) ?? null,
      kind: (args.kind as string | null) ?? null,
      slug: (args.slug as string | null) ?? null,
    });
  } catch (exc) {
    if (exc instanceof GraduationError) {
      error(exc.message);
      process.exit(1);
    }
    throw exc;
  }

  success(`Scaffolded ${result["scaffold_path"]}`);
  info(`Note marked graduated → ${result["graduated_to"]}`);
  info(
    "Ask Claude to run the sb-author skill to fill in the placeholder, " +
      "then `sandbox skills check` before committing.",
  );
}

/**
 * The SessionStart hook's stdin JSON (`source`, `session_id`, ...).
 *
 * A human running the command has a TTY (or no payload) and gets {} → the
 * neutral wording, no gate-state reset. Never raises: this feeds a launch hook.
 */
function hookPayload(): Record<string, any> {
  try {
    if (stdinIsatty()) {
      return {};
    }
    const raw = fs.readFileSync(0, "utf8");
    const data = raw.trim() ? JSON.parse(raw) : null;
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
  } catch {
    // a context hook must never break a launch
    return {};
  }
}

/** Execute ``sandbox notes <action>``. */
export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action === "graduate") {
    await runGraduate(args);
    return;
  }

  // context: hook-safe, must never raise or break a session launch
  try {
    const workspace = findWorkspaceRoot(process.cwd());
    if (workspace === null) {
      return;
    }
    const payload = hookPayload();
    const source = String(payload["source"] || "");
    // Standards gate (docs/jit-context-system.md §6):
    // compact/clear wipe the context, so delivered standards must re-gate.
    if (source === "compact" || source === "clear") {
      resetSessionState(workspace, String(payload["session_id"] || ""));
    }
    const context = buildContext(workspace, source);
    if (context) {
      process.stdout.write(context);
    }
  } catch {
    // a context hook must never break a launch
    return;
  }
}

/** Python `int(choice)` — strict base-10; returns null on ValueError. */
function parseIntStrict(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

/** Python `repr(list)` for a string list: ['a', 'b']. */
function reprList(items: string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}

/** Python `repr(tuple)` for a string tuple: ('a', 'b'). */
function reprTuple(items: readonly string[]): string {
  if (items.length === 1) return `('${items[0]}',)`;
  return `(${items.map((i) => `'${i}'`).join(", ")})`;
}
