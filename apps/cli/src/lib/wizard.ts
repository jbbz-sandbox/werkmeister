/**
 * Shared interactive-wizard machinery.
 *
 * A `PromptSpec` declares one input a command collects; `runWizard` drives a
 * list of them, prompting only for keys a caller hasn't already resolved and
 * validating each against its pattern. Extracted from init-workspace so
 * `sandbox config` (and any future command) reuses the same prompt loop, pattern
 * validation, and multi-value normalisation instead of restating them.
 *
 * The loop is deliberately decoupled from where defaults come from: callers pass
 * a `resolveDefault(spec) -> string` so init-workspace can derive defaults from
 * a workspace path while `config` derives them from the current YAML/env — the
 * runner never needs to know.
 */

import * as readline from "node:readline/promises";

import {
  checkbox,
  confirm as inquirerConfirm,
  editor,
  input,
  password,
  select,
} from "@inquirer/prompts";

import { info, warn } from "./config.js";

/** One interactive input a wizard collects. */
export interface PromptSpec {
  key: string;                                        // config-field name (feature, repos_root, …)
  label: string;                                      // prompt text shown to the user
  help: string;                                       // one-line "why it matters"
  acceptEmpty?: boolean;                              // may the user submit nothing? (default true)
  multi?: boolean;                                    // comma-separated multi-value (services)
  multiline?: boolean;                                // free-form prose (form: textarea widget)
  refinable?: boolean;                                // form: offer a "Refine with Claude" button
  refineInstruction?: string | null;                  // how Claude should rewrite the field
  recommended?: boolean;                              // strongly-recommended input (feature)
  pattern?: string | null;                            // anchored regex a non-empty value must match
  placeholder?: string | null;                        // example value (UI hint; not a default)
  defaultFn?: ((workspace: string) => string) | null; // derive a default from the workspace
  choicesFn?: (() => string[]) | null;                // enumerate valid values (services)
}

/** Ctrl-C / Ctrl-D: exit 130, never proceed to write partial state. */
function abort(): never {
  console.log();
  process.exit(130);
}

/**
 * Inquirer signals Ctrl-C by rejecting with `ExitPromptError`, where readline
 * emitted SIGINT. Anything else reaching here is a real fault, and reporting it
 * as a clean abort would hide the bug behind an exit code the user recognises.
 */
function abortIfCancelled(error: unknown): never {
  if ((error as Error)?.name !== "ExitPromptError") {
    throw error;
  }
  abort();
}

/** Read one line off a piped/redirected stdin, where Inquirer can't render. */
async function readLine(label: string, defaultValue: string): Promise<string> {
  const shown = defaultValue ? ` [${defaultValue}]` : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.on("SIGINT", () => reject(new Error("interrupted"))); // Ctrl-C
      rl.on("close", () => reject(new Error("eof")));          // Ctrl-D
      rl.question(`  ${label}${shown}: `).then(resolve, reject);
    });
  } catch {
    // Both rejections above are the user leaving; readline has no other failure
    // mode here worth distinguishing.
    abort();
  } finally {
    rl.close();
  }
}

/**
 * Render a prompt with an optional default; return input or default.
 *
 * `secret` masks the echo — for credentials like the Jira API token, which
 * otherwise sit in the scrollback of whoever ran `sandbox setup`.
 *
 * `multiline` prose (the starting prompt) opens $EDITOR, since paragraphs and
 * an acceptance-criteria checklist don't survive a single input line. Only when
 * the user has actually named an editor: Inquirer's fallback is bare `vim`, and
 * dropping someone into vim they didn't ask for costs them the whole wizard.
 */
export async function prompt(
  label: string,
  defaultValue = "",
  { secret = false, multiline = false }: { secret?: boolean; multiline?: boolean } = {},
): Promise<string> {
  if (!process.stdin.isTTY) {
    return (await readLine(label, defaultValue)).trim() || defaultValue;
  }
  try {
    // Inquirer hands back the raw line, so every path trims: a stray trailing
    // space fails the anchored pattern check, or lands in config.yaml verbatim
    // on the fields that have no pattern.
    if (secret) {
      return (await password({ message: label, mask: true })).trim() || defaultValue;
    }
    if (multiline && (process.env.VISUAL || process.env.EDITOR)) {
      // .md so the editor highlights prose; the text lands in Markdown anyway.
      const written = await editor({ message: label, default: defaultValue, postfix: ".md" });
      return written.trim() || defaultValue;
    }
    return (await input({ message: label, default: defaultValue || undefined })).trim() || defaultValue;
  } catch (e) {
    abortIfCancelled(e);
  }
}

/**
 * Ask a yes/no question. `fallback` is both the offered default and the answer
 * used verbatim when there's nobody to ask.
 */
export async function confirm(
  label: string,
  fallback: boolean,
  interactive = true,
): Promise<boolean> {
  if (!interactive) {
    return fallback;
  }
  if (!process.stdin.isTTY) {
    return /^y/i.test((await readLine(`${label} [y/n]`, fallback ? "y" : "n")).trim());
  }
  try {
    return await inquirerConfirm({ message: label, default: fallback });
  } catch (e) {
    abortIfCancelled(e);
  }
}

/**
 * Trim/dedupe a comma-separated multi-value input.
 *
 * Warns on unknown names when *choices* enumerates the valid set (e.g.
 * services); free-form multi-value fields (e.g. labels) pass `choices=null`
 * and skip that check.
 */
export function normalizeMulti(value: string, choices: string[] | null): string {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (let item of value.split(",")) {
    item = item.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }
  if (choices && choices.length) {
    const unknown = deduped.filter((s) => !choices.includes(s));
    if (unknown.length) {
      warn(`Unknown values will be skipped downstream: ${unknown.join(", ")}`);
    }
  }
  return deduped.join(",");
}

/** Sentinel select entry that drops the user back to free-text entry. */
const OTHER = Symbol("other");

/**
 * Pick from an enumerated set: an arrow-key list, or checkboxes when `multi`.
 *
 * Returns null when the choice can't be made this way — no TTY (piped stdin
 * still has to answer), or the user picked "Other". The caller then falls back
 * to typing, so a value the registry hasn't caught up with (a new GitHub org,
 * an unlisted repo) stays reachable instead of being locked out by the list.
 */
async function pickFromChoices(
  spec: PromptSpec,
  defaultValue: string,
  choices: string[],
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  // Multi-value defaults arrive in the same comma-separated form they're stored
  // in, so a re-run pre-checks whatever the last run selected.
  const preselected = new Set(defaultValue.split(",").map((s) => s.trim()).filter(Boolean));
  try {
    if (spec.multi) {
      const picked = await checkbox({
        message: spec.label,
        choices: choices.map((c) => ({ value: c, checked: preselected.has(c) })),
      });
      return picked.join(",");
    }
    const picked = await select<string | symbol>({
      message: spec.label,
      choices: [...choices.map((c) => ({ name: c, value: c })), { name: "Other (type it)", value: OTHER }],
      default: choices.includes(defaultValue) ? defaultValue : undefined,
    });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    abortIfCancelled(e);
  }
}

/**
 * Prompt repeatedly for one input until it satisfies the prompt's pattern.
 *
 * Empty input is allowed here (the caller applies `acceptEmpty`); the pattern
 * is the same regex the form UI validates against, so terminal and form agree.
 */
export async function promptOne(
  spec: PromptSpec,
  defaultValue: string,
  choices: string[] | null,
): Promise<string> {
  while (true) {
    let value = choices?.length ? await pickFromChoices(spec, defaultValue, choices) : null;
    value ??= await prompt(spec.label, defaultValue, { multiline: spec.multiline });
    if (spec.multi && value) {
      value = normalizeMulti(value, choices);
    }
    // Patterns are start-anchored only; a trailing `$` is the author's to add.
    if (value && spec.pattern && !new RegExp(`^(?:${spec.pattern})`).test(value)) {
      warn(`'${value}' doesn't match the expected format ${spec.pattern} — try again.`);
      continue;
    }
    return value;
  }
}

/**
 * Offer a Claude rewrite for a `refinable` field; returns the text to keep.
 *
 * The rewrite runs through `sandbox-driver`'s `refinePrompt` — the same
 * function behind the browser form's "Refine with Claude" button — so the
 * terminal honours the spec's `refineInstruction` instead of restating it and
 * drifting. The wizard's answers so far are passed as the form-state context
 * the driver grounds the rewrite in.
 *
 * Every failure path (declined, driver not built, `claude` missing, empty or
 * rejected rewrite) falls back to what the user typed — refine is an offer, so
 * it must never cost them their text. `ask` is injected for tests.
 */
export async function offerRefine(
  spec: PromptSpec,
  value: string,
  context: Record<string, string>,
  ask: (label: string, fallback: boolean) => Promise<boolean> = confirm,
): Promise<string> {
  if (!(await ask("Refine with Claude?", false))) {
    return value;
  }
  info("  Refining via the claude CLI — this takes a few seconds…");
  let refined: string;
  try {
    const { refinePrompt } = await import("sandbox-driver");
    refined = (await refinePrompt(value, spec.refineInstruction ?? "", context)).trim();
  } catch (e) {
    warn(`Refine failed (${(e as Error).message}) — keeping what you typed.`);
    return value;
  }
  if (!refined) {
    warn("Claude returned no text — keeping what you typed.");
    return value;
  }
  info(`\n${refined}\n`);
  return (await ask("Keep this version?", true)) ? refined : value;
}

/**
 * Prompt for any input not already present in `resolved`.
 *
 * Only missing keys are prompted — anything a caller resolved earlier
 * (CLI/env/config) is preserved. `resolveDefault(spec)` supplies the shown
 * default. Returns the (mutated) `resolved` dict.
 */
export async function runWizard(
  prompts: readonly PromptSpec[],
  resolved: Record<string, string>,
  resolveDefault: (spec: PromptSpec) => string,
  { intro = null }: { intro?: string | null } = {},
): Promise<Record<string, string>> {
  if (intro) {
    info(intro);
  }

  for (const spec of prompts) {
    if (spec.key in resolved) {
      continue;
    }

    const choices = spec.choicesFn ? spec.choicesFn() : null;
    if (spec.choicesFn && (!choices || choices.length === 0)) {
      // No values to choose from (e.g. services.yaml unavailable) — skip.
      continue;
    }
    // On a TTY the list is the picker itself; only the typed fallback needs it
    // spelled out.
    if (choices && choices.length && !process.stdin.isTTY) {
      info("  Choices: " + choices.join(", "));
    }

    const defaultValue = resolveDefault(spec);
    let value = await promptOne(spec, defaultValue, choices);
    if (spec.refinable && value) {
      value = await offerRefine(spec, value, resolved);
    }

    // acceptEmpty=false inputs are always recorded (the default stands in
    // when the user enters nothing); empty optional inputs are dropped.
    if (value || spec.acceptEmpty === false) {
      resolved[spec.key] = value;
    }
  }

  return resolved;
}
