import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
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
// Sidebar pages are checked by docs:check in lint (SW-715); the SDK pages exist only after `build` (typedoc), so here.
test("no Jira key in an SDK page's prose", () => {
  const pages = existsSync(join(ROOT, "apps/docs-site/sdk"))
    ? globSync("apps/docs-site/sdk/**/*.md", { cwd: ROOT })
    : [];
  const hits = pages
    .flatMap(proseLines)
    .filter(([, , l]) =>
      /\bSW-\d+\b/.test(l.replace(/`[^`]*`/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "")),
    )
    .map(([f, n, l]) => `${f}:${n}: ${l.trim().slice(0, 80)}`);
  assert.deepEqual(hits, []);
});

// SW-749: the SDK pages are for people building on it, so each shows how to call it.
test("every SDK symbol page has an example importing werkmeister-core/sdk", () => {
  const pages = existsSync(join(ROOT, "apps/docs-site/sdk"))
    ? globSync("apps/docs-site/sdk/*/*.md", { cwd: ROOT })
    : [];
  const missing = pages
    .filter(
      (f) =>
        !/^## Example\n[\s\S]*?```ts\n[^`]*from "werkmeister-core\/sdk"/m.test(
          readFileSync(join(ROOT, f), "utf8"),
        ),
    )
    .map((f) => f.replace(/^apps\/docs-site\/sdk\/|\.md$/g, ""))
    .sort();
  if (!pages.length) return;
  // shortcut: exports added before their examples are listed in sdk-example-todo.txt until SW-762; it only shrinks.
  const todo = readFileSync(join(ROOT, "apps/docs-site/sdk-example-todo.txt"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(missing, todo);
});

// Note numbers, PR numbers, internal entry points and CLI internals mean nothing to an SDK user.
// Symbol pages only, code spans included: index.md names `werkmeister-core/config` to say it is internal.
test("no internal reference in an SDK symbol page's prose", () => {
  const pages = existsSync(join(ROOT, "apps/docs-site/sdk"))
    ? globSync("apps/docs-site/sdk/*/*.md", { cwd: ROOT })
    : [];
  // The lookbehind lets "Defined in: packages/werkmeister-core/src/…" through.
  const internal =
    /\bnote \d+\b|(?<![\w/])#\d+\b|(?<![\w/])werkmeister-core\/(?!sdk\b)\w|\bmain\.ts\b|proposal §/;
  const hits = pages
    .flatMap(proseLines)
    .filter(([, , l]) => internal.test(l))
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
