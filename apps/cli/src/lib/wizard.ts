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

/**
 * Render a prompt with an optional default in brackets; return input or default.
 *
 * Ctrl-C / Ctrl-D exit with status 130 — never proceed to write partial state.
 */
export async function prompt(label: string, defaultValue = ""): Promise<string> {
  const shown = defaultValue ? ` [${defaultValue}]` : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let value: string;
  try {
    value = await new Promise<string>((resolve, reject) => {
      rl.on("SIGINT", () => reject(new Error("interrupted"))); // Ctrl-C
      rl.on("close", () => reject(new Error("eof")));          // Ctrl-D
      rl.question(`  ${label}${shown}: `).then(resolve, reject);
    });
  } catch {
    console.log();
    process.exit(130);
  } finally {
    rl.close();
  }
  return value.trim() || defaultValue;
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
    let value = await prompt(spec.label, defaultValue);
    if (spec.multi && value) {
      value = normalizeMulti(value, choices);
    }
    // Python `re.match` anchors at the start only — replicate that.
    if (value && spec.pattern && !new RegExp(`^(?:${spec.pattern})`).test(value)) {
      warn(`'${value}' doesn't match the expected format ${spec.pattern} — try again.`);
      continue;
    }
    return value;
  }
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
    if (choices && choices.length) {
      info("  Choices: " + choices.join(", "));
    }

    const defaultValue = resolveDefault(spec);
    const value = await promptOne(spec, defaultValue, choices);

    // acceptEmpty=false inputs are always recorded (the default stands in
    // when the user enters nothing); empty optional inputs are dropped.
    if (value || spec.acceptEmpty === false) {
      resolved[spec.key] = value;
    }
  }

  return resolved;
}
