// Smoke test for the Cowork artifact under its strict CSP (SW-53): the built
// dist/workspace-list.artifact.html must be one self-contained file — no external
// script, stylesheet or font, nothing that needs `unsafe-eval` — and still carry
// the React workspace card and its inlined fonts.
//   npm run build && node test/artifact-csp.smoke.mjs
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/workspace-list.artifact.html",
);
assert.ok(existsSync(file), `${file} is missing: run npm run build first`);
const html = readFileSync(file, "utf8");

for (const [what, re] of [
  ["an external script", /<script[^>]*\ssrc=/i],
  ["an external stylesheet", /<link[^>]*\shref=/i],
  ["a network url()", /url\(\s*["']?(https?:)?\/\//i],
  ["a CSS @import", /@import/i],
  ["eval", /\beval\(/],
  ["new Function", /new Function\(/],
])
  assert.doesNotMatch(html, re, `the artifact has ${what}`);

assert.match(html, /ws-card/, "the React card is bundled");
assert.equal(html.match(/data:font\/woff2/g)?.length, 6, "the six font faces are inlined");
assert.match(html, /"mcp__werkmeister__logs"/, "the artifact may call logs");

console.log("artifact-csp smoke: OK");
