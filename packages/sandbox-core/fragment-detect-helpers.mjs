// Shared fixtures for the fragment-detect tests. Not a test file: the
// `*.test.mjs` glob skips it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listRepoFiles } from "./dist/fragment_detect/index.js";

/** No git, no helm, no kubectl: every tool reads as missing. */
export const noTools = (cmd) =>
  cmd[0] === "git" ? [128, "fatal: not a git repository"] : [127, `${cmd[0]}: command not found`];

/**
 * Write *files* under a fresh `<tmp>/<name>` and return that path. A value is
 * written as-is when it is a string and as pretty JSON otherwise.
 */
export function fixture(files, name = "repo") {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "fragment-detect-")), name);
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return root;
}

/** A DetectContext over *root*, as planFragment builds it. */
export function ctxFor(root, runner = noTools) {
  return { root, files: listRepoFiles(root, runner), runner, skipped: [] };
}
