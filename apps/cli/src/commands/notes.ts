/**
 * sandbox notes <context|graduate>
 *
 * `context`: print the workspace's notes context for injection into a fresh
 * Claude Code window — the SessionStart hook target
 * (jit-context-system.md §5.8). The text is built by the workspace strategy's
 * `sessionContext` (jit: `buildContext`); this module resolves the workspace
 * from CWD, reads the hook's stdin payload, and writes the result to stdout —
 * plain text, hook-safe (never raises, always exits 0).
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
import { findWorkspaceRoot } from "sandbox-core/gate";
import { standardsDirPath } from "sandbox-core/global_config";
import {
  eligibleDomains,
  GraduationError,
  graduateNote,
  KINDS,
  matchDomainsForRefs,
} from "sandbox-core/graduate";
import { type Note, openDecisions } from "sandbox-core/notes";
import { loadStandardsModules } from "sandbox-core/standards";
import { strategyFor } from "sandbox-core/strategies";
import { error, info, success } from "../lib/config.js";

/** Write *promptStr*, read one line (no trailing newline). */
export async function input(promptStr: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(promptStr);
  } finally {
    rl.close();
  }
}

function stdinIsatty(): boolean {
  return Boolean(process.stdin.isTTY);
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
export async function graduateOne(
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
  info(`Note marked graduating → ${result["graduated_to"]}`);
  info(
    "Ask Claude to run the sb-author skill to fill in the placeholder, " +
      "then `sandbox skills check`.",
  );
  // The scaffold and the note live in different repos; saying so here is the
  // difference between "two commits" and "one commit and a silent orphan".
  info(
    `Commit it in ${standardsDirPath()} — a separate repo from this workspace. ` +
      "The note stays an open decision until that file is tracked.",
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
    const context = strategyFor(workspace).sessionContext(workspace, hookPayload());
    if (context) {
      process.stdout.write(context);
    }
  } catch {
    // a context hook must never break a launch
    return;
  }
}

/** Strict base-10 parse; returns null on anything that is not an integer. */
function parseIntStrict(s: string): number | null {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

/** Render a string list as `['a', 'b']`. */
function reprList(items: string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}

/** Render a string tuple as `('a', 'b')`. */
function reprTuple(items: readonly string[]): string {
  if (items.length === 1) return `('${items[0]}',)`;
  return `(${items.map((i) => `'${i}'`).join(", ")})`;
}
