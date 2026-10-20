// The token rules from the handoff README's acceptance checks (SW-53): hex colours
// live only in tokens.css, every text/background pair the card draws passes WCAG AA
// in light and dark, solid amber means Needs you only, and no font is fetched.
// Run: npm run build && node --test test/tokens.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const src = new URL("../src/", import.meta.url);
const tokensCss = fs.readFileSync(new URL("tokens.css", src), "utf8");
const files = fs
  .readdirSync(src, { recursive: true })
  .filter((f) => /\.(ts|tsx|css)$/.test(f) && !f.endsWith(".d.ts"))
  .map((f) => ({ f, text: fs.readFileSync(new URL(f, src), "utf8") }));

test("no hex colour outside tokens.css", () => {
  for (const { f, text } of files) {
    if (path.basename(f) === "tokens.css") continue;
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(text),
      `${f}: ${text.match(/.*#[0-9a-fA-F]{3,8}\b.*/)?.[0]}`,
    );
  }
});

test("every --sd-* a module reads is defined in tokens.css", () => {
  const defined = new Set(tokensCss.match(/--sd-[a-z-]+(?=:)/g));
  for (const { f, text } of files)
    for (const [, name] of text.matchAll(/var\((--sd-[a-z-]+)/g))
      assert.ok(defined.has(name), `${f} reads undefined ${name}`);
});

test("fonts load from the bundle only", () => {
  assert.doesNotMatch(tokensCss, /url\(\s*["']?(https?:)?\/\//);
  assert.doesNotMatch(tokensCss, /@import/);
  for (const [, url] of tokensCss.matchAll(/url\(([^)]+)\)/g))
    assert.ok(fs.existsSync(new URL(url, src)), `${url} is missing`);
});

test("solid amber and the attention colours only style Needs you", async () => {
  const { CARD_CSS } = await import("../dist/workspace-card.js");
  const ui = fs.readFileSync(new URL("workspace-ui.tsx", src), "utf8");
  const css = CARD_CSS + ui.slice(ui.indexOf("const CSS = `"));
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (/--sd-(warn-solid|on-warn-solid|attn-)/.test(body))
      assert.match(selector, /attn|needs/, `amber outside Needs you: ${selector.trim()}`);
});

/** The `--sd-*` hex values of one `:root { … }` block. */
function palette(block) {
  return Object.fromEntries(
    [...block.matchAll(/--sd-([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]),
  );
}
const light = palette(tokensCss.slice(0, tokensCss.indexOf("@media")));
const dark = { ...light, ...palette(tokensCss.slice(tokensCss.indexOf("@media"))) };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background] as the card, top bar, filter and confirms draw them.
const PAIRS = [
  ...["ink", "muted", "faint", "info", "ok", "warn", "err", "off", "pr"].flatMap((t) => [
    [t, "card"],
    [t, "bg"],
  ]),
  ...["ok", "warn", "err", "off", "pr"].map((t) => [t, `${t}-bg`]),
  ["muted", "off-bg"],
  ["on-warn-solid", "warn-solid"],
  ["ink", "attn-bg"],
  ["info", "attn-bg"],
  ["warn", "attn-bg"],
  ["on-accent", "accent"],
  ["ink", "err-bg"],
  ["muted", "err-bg"],
  ["card", "err"],
  ["card", "ink"],
  ["ink", "hover"],
];

test("every text/background pair is AA (≥ 4.5:1) in light and dark", () => {
  for (const [theme, p] of [
    ["light", light],
    ["dark", dark],
  ])
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(p[fg], p[bg]);
      assert.ok(ratio >= 4.5, `${theme}: --sd-${fg} on --sd-${bg} is ${ratio.toFixed(2)}:1`);
    }
});
