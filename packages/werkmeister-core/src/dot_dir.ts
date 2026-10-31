/**
 * The tool's dot-directory under `~` or a workspace root. Kept dependency-free so
 * the hook fast paths (gate.ts, pr_guard.ts) can import it without pulling in
 * config.ts's yaml chain. `werkmeister machine migrate` moves a pre-rename `.sandbox`. // name-check: ignore
 */

import * as path from "node:path";

export const DOT_DIR = ".werkmeister";

export function dotDir(parent: string): string {
  return path.join(parent, DOT_DIR);
}
