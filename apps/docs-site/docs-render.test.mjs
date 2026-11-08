import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = globSync("docs/*.md", { cwd: ROOT });

/** Lines outside ``` fences, as [file, lineNo, text]. */
function proseLines(f) {
  let fenced = false;
  return readFileSync(join(ROOT, f), "utf8")
    .split("\n")
    .flatMap((l, i) => {
      const fence = /^\s*```/.test(l);
      if (fence) fenced = !fenced;
      return fenced || fence ? [] : [[f, i + 1, l]];
    });
}

// VitePress runs Vue interpolation over prose and inline code; only fences are v-pre.
test("no unescaped {{ }} in prose", () => {
  const hits = FILES.flatMap(proseLines)
    .filter(([, , l]) => /\{\{/.test(l.replace(/<code v-pre>.*?<\/code>/g, "")))
    .map(([f, n, l]) => `${f}:${n}: ${l.trim().slice(0, 80)}`);
  assert.deepEqual(hits, []);
});

// A `|` row after a blank line or paragraph starts no table: it renders as a stray paragraph.
test("no table row outside its table", () => {
  const hits = FILES.flatMap((f) => {
    const L = proseLines(f);
    return L.flatMap(([, n, l], i) => {
      if (!l.startsWith("|")) return [];
      const prev = L[i - 1]?.[2] ?? "";
      const next = L[i + 1]?.[2] ?? "";
      // fine when it continues a table, or is a header followed by the separator row
      return prev.startsWith("|") || /^\|[\s:|-]+\|$/.test(next)
        ? []
        : [`${f}:${n}: ${l.slice(0, 60)}`];
    });
  });
  assert.deepEqual(hits, []);
});

test("harnesses.md table rows fit the content column", () => {
  const long = readFileSync(join(ROOT, "docs/harnesses.md"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("|") && l.length > 200);
  assert.deepEqual(
    long.map((l) => l.slice(0, 60)),
    [],
  );
});
