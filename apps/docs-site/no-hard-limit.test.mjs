import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  ...globSync("docs/*.md", { cwd: ROOT }),
  "apps/cli/README.md",
  "apps/cli/src/main.ts",
  "README.md",
];
// 12 is the default `feature_slots.count`, not a ceiling (SW-98); these phrasings state it as one.
const HARD_LIMIT = /up to 12|12 concurrent|all 12 (slots|features)|12 features × /i;

test("no doc states 12 features as a hard limit", () => {
  const hits = FILES.flatMap((f) =>
    readFileSync(join(ROOT, f), "utf8")
      .split("\n")
      .flatMap((l, i) => (HARD_LIMIT.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])),
  );
  assert.deepEqual(hits, []);
});
