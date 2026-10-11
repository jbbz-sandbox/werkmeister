// One create entry point: apps and plugins call createWorkspace, never provisionWorkspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const SKIP = new Set(["node_modules", "dist", "__tests__", ".turbo"]);

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

test("no app or plugin calls provisionWorkspace", () => {
  const hits = ["apps", "plugins"].flatMap((d) => sources(path.join(REPO, d)))
    .filter((f) => /\bprovisionWorkspace\b/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(REPO, f));
  assert.deepEqual(hits, []);
});
