import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import config from "./.vitepress/config.mjs";

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

// SW-611: a heading id on the site must be the one GitHub and docs:check compute.
test("site heading ids follow GitHub's slug rule", () => {
  const { slugify } = config.markdown.anchor;
  assert.equal(slugify("Slots & port ranges"), "slots--port-ranges");
  assert.equal(
    slugify("werkmeister.services.yaml (generated)"),
    "werkmeisterservicesyaml-generated",
  );
});

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

// Readers can't open the tracker; git history keeps the keys. A key may stay as a link, or as an example in code.
test("no Jira key in a sidebar page's prose", () => {
  const pages = config.themeConfig.sidebar.flatMap((g) =>
    g.items.map((i) => `${i.link.slice(1)}.md`),
  );
  const hits = pages
    .flatMap(proseLines)
    .filter(([, , l]) =>
      /\bSW-\d+\b/.test(l.replace(/`[^`]*`/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "")),
    )
    .map(([f, n, l]) => `${f}:${n}: ${l.trim().slice(0, 80)}`);
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
