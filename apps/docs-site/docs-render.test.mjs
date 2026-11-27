import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { braceLines } from "../../scripts/check-docs.mjs";
import config from "./.vitepress/config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = globSync("docs/*.md", { cwd: ROOT });

/** The generated SDK pages matching `pattern`; fails when the build hasn't written them, so a scan is never skipped. */
function sdkPages(pattern) {
  assert.ok(
    existsSync(join(ROOT, "apps/docs-site/sdk")),
    "apps/docs-site/sdk/ is missing: run `pnpm turbo run build --filter=docs-site` first",
  );
  return globSync(pattern, { cwd: ROOT });
}

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

// docs:check runs the same rule in lint (SW-1123); this keeps the built site's own check.
test("no unescaped {{ }} in prose", () => {
  const hits = FILES.flatMap((f) => braceLines(f, readFileSync(join(ROOT, f), "utf8")));
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
  const pages = sdkPages("apps/docs-site/sdk/**/*.md");
  const hits = pages
    .flatMap(proseLines)
    .filter(([, , l]) =>
      /\bSW-\d+\b/.test(l.replace(/`[^`]*`/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "")),
    )
    .map(([f, n, l]) => `${f}:${n}: ${l.trim().slice(0, 80)}`);
  assert.deepEqual(hits, []);
});

// Note numbers, PR numbers, internal entry points and CLI internals mean nothing to an SDK user.
// Symbol pages only, code spans included: index.md names `werkmeister-core/config` to say it is internal.
test("no internal reference in an SDK symbol page's prose", () => {
  const pages = sdkPages("apps/docs-site/sdk/*/*.md");
  // The lookbehind lets "Defined in: packages/werkmeister-core/src/…" through.
  const internal =
    /\b[Nn]ote \d+\b|(?<![\w/])#\d+\b|(?<![\w/])werkmeister-core\/(?!sdk\b)\w|\bmain\.ts\b|proposal §/;
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
