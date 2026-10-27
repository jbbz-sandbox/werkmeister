/**
 * Shared interactive-wizard machinery.
 *
 * Every prompt renders from the form schema (`buildFormSchema`'s RJSF bundle) —
 * the one definition the browser form and MCP UI also render — so all surfaces
 * show the same fields, choices, groups and validation. `runFormWizard` drives a
 * whole bundle; `runWizard` drives `PromptSpec`s one field at a time, prompting
 * only for keys a caller hasn't already resolved. Extracted from init-workspace so
 * `werkmeister config` (and any future command) reuses the same prompt loop, pattern
 * validation, and multi-value normalisation instead of restating them.
 *
 * Defaults come from the bundle's `formData`, or for `runWizard` from the
 * caller's `resolveDefault(spec)`, so `setup`/`config` can derive them from the
 * current YAML/env and the answers given so far — the runner never needs to know.
 */

import * as readline from "node:readline/promises";

import {
  checkbox,
  editor,
  input,
  confirm as inquirerConfirm,
  password,
  Separator,
  select,
} from "@inquirer/prompts";
import { buildFormSchema } from "werkmeister-core/form_schema";
import type { PromptSpec } from "werkmeister-core/global_config";
import { promptEntry } from "werkmeister-core/workspace_prompts";
import { info, warn } from "./config.js";

// Re-exported so the commands and `browser.ts` that drive a wizard keep naming
// one module for the runner and the shape it runs.
export type { PromptSpec };

/** Ctrl-C / Ctrl-D: exit 130, never proceed to write partial state. */
function abort(reason?: string): never {
  console.log();
  if (reason) warn(reason);
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
      rl.on("close", () => reject(new Error("eof"))); // Ctrl-D, or an empty/exhausted pipe
      rl.question(`  ${label}${shown}: `).then(resolve, reject);
    });
  } catch (e) {
    // Without this, an agent's empty stdin ended at the prompt with a bare blank line (SW-90).
    abort(
      (e as Error).message === "eof"
        ? "No answer: stdin is not a terminal and had no input left -- nothing changed."
        : undefined,
    );
  } finally {
    rl.close();
  }
}

/**
 * Render a prompt with an optional default; return input or default.
 *
 * `secret` masks the echo — for credentials like the Jira API token, which
 * otherwise sit in the scrollback of whoever ran `werkmeister setup`.
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
    return (
      (await input({ message: label, default: defaultValue || undefined })).trim() || defaultValue
    );
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
  if (choices?.length) {
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
 * One input as the form schema describes it. Every prompt renders from this,
 * read off an RJSF bundle by {@link fieldsOf}, so the terminal shows exactly
 * what the browser form and MCP UI show.
 */
export interface WizardField {
  key: string;
  label: string;
  multi?: boolean;
  multiline?: boolean;
  boolean?: boolean;
  pattern?: string | null;
  choices?: string[] | null;
  groups?: Record<string, string[]> | null; // group heading → its choices
  required?: boolean;
  refinable?: boolean;
  refineInstruction?: string | null;
  default?: string;
}

/** Read the fields of a {@link buildFormSchema} bundle, in `ui:order`. */
export function fieldsOf(bundle: Record<string, any>): WizardField[] {
  const { schema, uiSchema = {}, formData = {} } = bundle;
  const required = new Set<string>(schema.required ?? []);
  const order: string[] = uiSchema["ui:order"] ?? Object.keys(schema.properties ?? {});
  return order.map((key) => {
    const prop = schema.properties[key];
    const ui = uiSchema[key] ?? {};
    const opts = ui["ui:options"] ?? {};
    const value = formData[key];
    return {
      key,
      label: prop.title ?? key,
      multi: prop.type === "array",
      multiline: ui["ui:widget"] === "textarea",
      boolean: prop.type === "boolean",
      pattern: prop.pattern ?? null,
      choices: prop.items?.enum ?? prop.enum ?? null,
      groups: opts.groups ?? null,
      required: required.has(key),
      refinable: Boolean(opts.refinable),
      refineInstruction: opts.refineInstruction ?? null,
      default: Array.isArray(value) ? value.join(",") : String(value ?? ""),
    };
  });
}

/**
 * List *items* under a Separator per group (e.g. services under their repo),
 * in the groups' order; anything no group names goes last under "other".
 * No groups → *items* unchanged.
 */
function withGroupHeadings<T extends { value: string }>(
  items: T[],
  groups: Record<string, string[]> | null | undefined,
): (T | Separator)[] {
  if (!groups) {
    return items;
  }
  const remaining = new Map(items.map((item) => [item.value, item]));
  const out: (T | Separator)[] = [];
  const section = (heading: string, members: T[]) => {
    if (members.length) {
      out.push(new Separator(`── ${heading} ──`), ...members);
    }
  };
  for (const [heading, values] of Object.entries(groups)) {
    const members = values.flatMap((v) => remaining.get(v) ?? []);
    for (const m of members) remaining.delete(m.value);
    section(heading, members);
  }
  section("other", [...remaining.values()]);
  return out;
}

/**
 * Pick from an enumerated set: an arrow-key list, or checkboxes when `multi`.
 *
 * Returns null when the choice can't be made this way — no TTY (piped stdin
 * still has to answer), or the user picked "Other". The caller then falls back
 * to typing, so a value the registry hasn't caught up with (a new GitHub org,
 * an unlisted repo) stays reachable instead of being locked out by the list.
 */
async function pickFromChoices(
  field: WizardField,
  defaultValue: string,
  choices: string[],
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  // Multi-value defaults arrive in the same comma-separated form they're stored
  // in, so a re-run pre-checks whatever the last run selected.
  const preselected = new Set(
    defaultValue
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  try {
    if (field.multi) {
      const picked = await checkbox({
        message: field.label,
        choices: withGroupHeadings(
          choices.map((c) => ({ value: c, checked: preselected.has(c) })),
          field.groups,
        ),
      });
      return picked.join(",");
    }
    const picked = await select<string | symbol>({
      message: field.label,
      choices: [
        ...choices.map((c) => ({ name: c, value: c })),
        { name: "Other (type it)", value: OTHER },
      ],
      default: choices.includes(defaultValue) ? defaultValue : undefined,
    });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    abortIfCancelled(e);
  }
}

/**
 * Prompt repeatedly for one input until it satisfies the field's pattern.
 *
 * Empty input is allowed here (the caller applies `required`); the pattern is
 * the schema's own, so terminal and form validate against the same regex.
 */
export async function promptOne(
  field: WizardField,
  defaultValue: string,
  choices: string[] | null = field.choices ?? null,
): Promise<string> {
  while (true) {
    let value = choices?.length ? await pickFromChoices(field, defaultValue, choices) : null;
    value ??= await prompt(field.label, defaultValue, { multiline: field.multiline });
    if (field.multi && value) {
      value = normalizeMulti(value, choices);
    }
    // Patterns are start-anchored only; a trailing `$` is the author's to add.
    if (value && field.pattern && !new RegExp(`^(?:${field.pattern})`).test(value)) {
      warn(`'${value}' doesn't match the expected format ${field.pattern} — try again.`);
      continue;
    }
    return value;
  }
}

/**
 * Offer a Claude rewrite for a `refinable` field; returns the text to keep.
 *
 * The rewrite runs through `werkmeister-core`'s `refinePrompt` — the same
 * function behind the browser form's "Refine with Claude" button — so the
 * terminal honours the field's `refineInstruction` instead of restating it and
 * drifting. The wizard's answers so far are passed as the form-state context
 * werkmeister-core grounds the rewrite in.
 *
 * Every failure path (declined, werkmeister-core not built, `claude` missing, empty or
 * rejected rewrite) falls back to what the user typed — refine is an offer, so
 * it must never cost them their text. `ask` is injected for tests.
 */
export async function offerRefine(
  field: Pick<WizardField, "refineInstruction">,
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
    const { refinePrompt } = await import("werkmeister-core");
    refined = (await refinePrompt(value, field.refineInstruction ?? "", context)).trim();
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

/** Ask one field and record the answer in *resolved*. */
export async function askField(
  field: WizardField,
  resolved: Record<string, string>,
): Promise<void> {
  if (field.boolean) {
    resolved[field.key] = String(await confirm(field.label, field.default === "true"));
    return;
  }
  // On a TTY the list is the picker itself; only the typed fallback needs it
  // spelled out.
  if (field.choices?.length && !process.stdin.isTTY) {
    info("  Choices: " + field.choices.join(", "));
  }
  let value = await promptOne(field, field.default ?? "");
  if (field.refinable && value) {
    value = await offerRefine(field, value, resolved);
  }
  // Required inputs are always recorded (the default stands in when the user
  // enters nothing); empty optional inputs are dropped.
  if (value || field.required) {
    resolved[field.key] = value;
  }
}

/**
 * Prompt for every field of a form-schema bundle not already in `resolved` —
 * the same bundle the browser form and MCP UI render. Returns the (mutated)
 * `resolved` dict.
 */
export async function runFormWizard(
  bundle: Record<string, any>,
  resolved: Record<string, string>,
  {
    intro = null,
    afterField,
  }: {
    intro?: string | null;
    /** Runs after each answered field; what it returns becomes the default of later fields. */
    afterField?: (key: string, resolved: Record<string, string>) => Promise<Record<string, string>>;
  } = {},
): Promise<Record<string, string>> {
  if (intro) {
    info(intro);
  }
  const defaults: Record<string, string> = {};
  for (const field of fieldsOf(bundle)) {
    if (!(field.key in resolved)) {
      await askField(
        defaults[field.key] ? { ...field, default: defaults[field.key] } : field,
        resolved,
      );
    }
    if (afterField && field.key in resolved) {
      Object.assign(defaults, await afterField(field.key, resolved));
    }
  }
  return resolved;
}

/**
 * Prompt for any of *prompts* not already present in `resolved`.
 *
 * For callers whose defaults follow earlier answers (`setup`, `config`):
 * `resolveDefault(spec)` runs just before each prompt, and that prompt is then
 * rendered through a one-field form schema — so these wizards share the
 * schema path with {@link runFormWizard} without a static bundle.
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
    const entry = {
      ...promptEntry(spec, "", resolved, { defaults: false }),
      default: resolveDefault(spec),
    };
    for (const field of fieldsOf(buildFormSchema({ prompts: [entry] }))) {
      await askField(field, resolved);
    }
  }
  return resolved;
}
