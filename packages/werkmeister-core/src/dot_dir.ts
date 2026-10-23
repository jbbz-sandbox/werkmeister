/**
 * The tool's dot-directory, renamed `.sandbox` → `.werkmeister` (SW-7). Kept
 * dependency-free so the hook fast paths (gate.ts, pr_guard.ts) can import it
 * without pulling in config.ts's yaml chain.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** New name first; the old one is read in place, never moved. */
export const DOT_DIRS = [".werkmeister", ".sandbox"] as const;

/**
 * The tool's dot-directory under `parent` (`~` or a workspace root): the first
 * of {@link DOT_DIRS} that exists, else the new name, so a fresh install or a
 * new workspace starts out renamed.
 */
export function dotDir(parent: string): string {
  const found = DOT_DIRS.find((d) => fs.existsSync(path.join(parent, d)));
  return path.join(parent, found ?? DOT_DIRS[0]);
}

/**
 * Point generated text's workspace `.sandbox/` mentions at `root`'s dot-dir.
 * Rewrites only a bare or `../`-relative `.sandbox/`, so `~/.sandbox/` and
 * `$HOME/.sandbox/` (the global dir) stay as written. Identity in a `.sandbox`
 * workspace, so existing workspaces regenerate byte-for-byte.
 */
export function forDotDir(text: string, root: string): string {
  const name = path.basename(dotDir(root));
  if (name === ".sandbox") return text;
  return text.replace(/(^|[\s`'"([|]|\.\.\/)\.sandbox\//gm, `$1${name}/`);
}
