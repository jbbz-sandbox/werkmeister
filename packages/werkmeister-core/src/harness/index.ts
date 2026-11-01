import { claudeAdapter } from "./claude/index.js";
import type { HarnessAdapter } from "./types.js";

export type { HarnessAdapter, HarnessId } from "./types.js";

/** The harness this process drives. Claude Code is the only adapter until SW-188. */
export function harness(): HarnessAdapter {
  return claudeAdapter;
}
