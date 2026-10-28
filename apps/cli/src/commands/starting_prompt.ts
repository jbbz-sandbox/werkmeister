/**
 * werkmeister starting-prompt [--start <dir>]
 *
 * Print the enclosing workspace's `starting_prompt` (the starting-prompt
 * skill). Exit 1 when no workspace.yml is found walking up from --start,
 * 2 when it has no non-empty starting_prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readWorkspaceYaml } from "werkmeister-core/browser";
import { dotDir } from "werkmeister-core/dot_dir";
import { error } from "../lib/config.js";

/** The workspace enclosing `start` (default cwd); exits 1 when there is none. */
export function findWorkspaceDir(start: string | null): string {
  const from = path.resolve(start ?? ".");
  let dir = from;
  // Checks for workspace.yml, not just the dot-dir: ~/.werkmeister is one too.
  while (!fs.existsSync(path.join(dotDir(dir), "workspace.yml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      error(`No .werkmeister/workspace.yml found from ${from}`);
      process.exit(1);
    }
    dir = parent;
  }
  return dir;
}

export function run(args: Record<string, unknown>): void {
  const dir = findWorkspaceDir(args.start as string | null);
  const prompt = readWorkspaceYaml(dir).starting_prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    error(`${dir} has no starting_prompt`);
    process.exit(2);
  }
  console.log(prompt.trim());
}
