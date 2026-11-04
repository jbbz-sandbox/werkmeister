// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { claudeAdapter } from "./claude/index.js";
import type { HarnessAdapter } from "./types.js";

export type { HarnessAdapter, HarnessId, HarnessLayout } from "./types.js";
export { HARNESS_IDS } from "./types.js";

/**
 * The harness whose sessions this process drives: Claude Code. Where a workspace's
 * files go is per workspace: `harnessLayoutFor` in ./layout.js, exported as
 * `werkmeister-core/harness_layout` and not from here: jira.ts imports this module,
 * and layout.js reaches jira.ts through workspace_prompts, which would be a cycle.
 */
export function harness(): HarnessAdapter {
  return claudeAdapter;
}
