/**
 * Nearest-`.env` lookup for the commands that accept a feature implicitly.
 *
 * `werkmeister feature up`/`down`/`stop`/`restart`/`open`/`intercept` all resolve their
 * feature as `args.feature || FEATURE from the nearest .env`, so running one
 * inside a workspace needs no argument. Each carried its own copy of this walk;
 * the copies drifted into four variants, two of which were behind on the fixes
 * below, so there is one now.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { unquoteEnvValue } from "werkmeister-core/workspace_prompts";

/** Walk up from *start* to the filesystem root; the first `.env` file found, or null. */
export function findDotenv(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const envFile = path.join(dir, ".env");
    // stat-and-catch rather than existsSync-then-stat: the pair races a
    // concurrent `werkmeister feature down` deleting the file between the two calls, and
    // throws on a dangling symlink or an unreadable parent.
    let isFile = false;
    try {
      isFile = fs.statSync(envFile).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) return envFile;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse the nearest `.env` at or above *start*.
 * Returns `{}` when there is none — an absent file is the normal case outside a
 * workspace, not an error.
 */
export function loadDotenv(start: string): Record<string, string> {
  const envFile = findDotenv(start);
  if (!envFile) return {};
  const result: Record<string, string> = {};
  // \r?\n, not \n: a CRLF .env otherwise leaves a trailing \r on every
  // value, and `FEATURE=foo\r` resolves no slot and no containers.
  for (let line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    result[key.trim()] = unquoteEnvValue(value.trim());
  }
  return result;
}
