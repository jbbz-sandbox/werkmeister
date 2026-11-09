import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const css = readFileSync(join(ROOT, "apps/docs-site/.vitepress/theme/custom.css"), "utf8");
// The selector of the rule that sets `filter: invert(...)` under .dark.
const rule = css.match(/([^{}]*)\{[^}]*filter:\s*invert/);
const attrs = rule ? [...rule[1].matchAll(/\[src([*$]?)=["']([^"']+)["']\]/g)] : [];
const inverted = (src) =>
  attrs.length > 0 && attrs.every(([, op, v]) => (op === "$" ? src.endsWith(v) : src.includes(v)));

// VitePress serves docs/images/x as /images/x.
const srcs = globSync("docs/*.md", { cwd: ROOT }).flatMap((f) =>
  [...readFileSync(join(ROOT, f), "utf8").matchAll(/!\[[^\]]*\]\((images\/[^)\s]+)\)/g)].map(
    (m) => `/${m[1]}`,
  ),
);

test("dark theme inverts every mermaid SVG under /images/", () => {
  const svgs = srcs.filter((s) => s.endsWith(".svg"));
  assert.ok(svgs.includes("/images/werkmeister-architecture/request-path.svg"));
  assert.deepEqual(
    svgs.filter((s) => !inverted(s)),
    [],
  );
});

test("dark theme leaves PNG screenshots alone", () => {
  const pngs = srcs.filter((s) => s.endsWith(".png"));
  assert.ok(pngs.length > 0);
  assert.deepEqual(pngs.filter(inverted), []);
});
