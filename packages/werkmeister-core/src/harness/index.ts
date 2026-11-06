// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { claudeAdapter } from "./claude/index.js";
import type { HarnessAdapter } from "./types.js";

export type { HarnessAdapter, HarnessId, HarnessLayout } from "./types.js";
export { HARNESS_IDS } from "./types.js";

/**
 * The machine-level adapter, for callers with no workspace (the Jira fallback, refine,
 * distill, PR reconcile): Claude Code. A workspace's own sessions and files follow its
 * `harness:`: `harnessFor` / `harnessLayoutFor` in ./layout.js, exported as
 * `werkmeister-core/harness_layout` and not from here: jira.ts imports this module,
 * and layout.js reaches jira.ts through workspace_prompts, which would be a cycle.
 */
export function harness(): HarnessAdapter {
  return claudeAdapter;
}
