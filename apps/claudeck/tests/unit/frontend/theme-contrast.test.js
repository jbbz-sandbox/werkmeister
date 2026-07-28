// Palette guard: parses the real CSS and checks every theme against WCAG 2.1.
// This is what stops a new theme (or a tweak to an existing one) from shipping
// text nobody can read — the failure mode that prompted the theme work.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Paths come from import.meta.dirname rather than new URL(..., import.meta.url):
// happy-dom replaces globalThis.URL with one that resolves relative paths
// against document.location, so the same expression yields a file:// URL at
// module scope and an http:// one inside a test body, and fileURLToPath rejects
// the latter. A plain path string has no such ambiguity.
const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../../public");

const css = (p) => readFileSync(path.join(PUBLIC_DIR, p), "utf8");
const VARIABLES = css("css/core/variables.css");
const THEMES_CSS = css("css/core/themes.css");

// ── WCAG 2.1 relative luminance / contrast ratio ──────────
const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// ── Parse `--token: #hex;` out of a declaration block ─────
function tokensIn(block) {
  const out = {};
  for (const [, name, hex] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[name] = hex;
  }
  return out;
}

const base = tokensIn(VARIABLES.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);

const overrides = {};
for (const [, id, block] of THEMES_CSS.matchAll(/html\[data-theme="([a-z-]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
  overrides[id] = tokensIn(block);
}

// Each theme inherits :root and overrides part of it — the same cascade the
// browser applies, so the values tested are the values that render.
const THEMES = { dark: base, ...Object.fromEntries(
  Object.entries(overrides).map(([id, o]) => [id, { ...base, ...o }])
) };

// Surfaces that body text actually sits on. --bg-deep and --bg-elevated are
// included because modals and code blocks use them.
const SURFACES = ["--bg", "--bg-secondary", "--bg-tertiary", "--bg-deep", "--bg-elevated"];
const TEXT = ["--text", "--text-secondary", "--text-dim"];
const AA_TEXT = 4.5;   // WCAG 1.4.3 — normal-size text
const AA_NONTEXT = 3;  // WCAG 1.4.11 — UI component boundaries

describe("theme palettes", () => {
  it("discovers every theme declared in themes.css plus the :root default", () => {
    expect(Object.keys(THEMES).sort()).toEqual(["dark", "darkly", "flatly", "light", "nord"]);
  });

  describe.each(Object.entries(THEMES))("%s", (id, t) => {
    it("defines every token the other themes define", () => {
      // A token missing from one theme silently falls back to the dark
      // default, which is how you get a green glow on a light palette.
      expect(Object.keys(base).filter((k) => !(k in t))).toEqual([]);
    });

    it.each(TEXT)(`%s reads at ${AA_TEXT}:1 on every surface`, (token) => {
      for (const surface of SURFACES) {
        const ratio = contrast(t[token], t[surface]);
        expect(
          ratio,
          `${id}: ${token} (${t[token]}) on ${surface} (${t[surface]}) = ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    it(`--accent reads at ${AA_TEXT}:1 on the main surfaces`, () => {
      for (const surface of ["--bg", "--bg-secondary", "--bg-tertiary"]) {
        const ratio = contrast(t["--accent"], t[surface]);
        expect(
          ratio,
          `${id}: --accent (${t["--accent"]}) on ${surface} (${t[surface]}) = ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    it(`--on-accent reads at ${AA_TEXT}:1 on an --accent-solid fill`, () => {
      const ratio = contrast(t["--on-accent"], t["--accent-solid"]);
      expect(
        ratio,
        `${id}: --on-accent (${t["--on-accent"]}) on --accent-solid (${t["--accent-solid"]}) = ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });

    // Fills other than accent use color: var(--bg) rather than a dedicated
    // token, so --bg has to stay legible on each of them.
    it.each(["--error", "--warning", "--purple"])(
      `--bg reads at ${AA_TEXT}:1 on a %s fill`,
      (fill) => {
        const ratio = contrast(t["--bg"], t[fill]);
        expect(
          ratio,
          `${id}: --bg (${t["--bg"]}) on ${fill} (${t[fill]}) = ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    );

    it(`--border-strong hits ${AA_NONTEXT}:1 on --bg so form controls are findable`, () => {
      const ratio = contrast(t["--border-strong"], t["--bg"]);
      expect(
        ratio,
        `${id}: --border-strong (${t["--border-strong"]}) on --bg (${t["--bg"]}) = ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA_NONTEXT);
    });
  });
});

describe("token hygiene", () => {
  it("leaves no var(--token) reference undefined", async () => {
    // An undefined custom property makes the whole declaration invalid, so the
    // rule silently does nothing and cannot respond to a theme change.
    const { glob } = await import("node:fs/promises");
    const defined = new Set([
      ...Object.keys(base),
      ...Object.values(overrides).flatMap((o) => Object.keys(o)),
      // Aliases defined as var() pass-throughs rather than hex literals
      ...VARIABLES.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(/g).map((m) => m[1]),
      // Non-color tokens (fonts, spacing, easing, effects)
      ...VARIABLES.matchAll(/(--[a-z0-9-]+)\s*:/g).map((m) => m[1]),
    ]);

    const missing = new Map();
    for await (const entry of glob("css/**/*.css", { cwd: PUBLIC_DIR })) {
      const text = readFileSync(path.join(PUBLIC_DIR, entry), "utf8");
      for (const [, token] of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(token)) {
          if (!missing.has(token)) missing.set(token, new Set());
          missing.get(token).add(entry);
        }
      }
    }
    const report = [...missing].map(([t, f]) => `${t} (${[...f].join(", ")})`);
    expect(report).toEqual([]);
  });
});
