// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Paths come from import.meta.dirname rather than new URL(..., import.meta.url):
// happy-dom replaces globalThis.URL with one that resolves relative paths
// against document.location, so the same expression yields a file:// URL at
// module scope and an http:// one inside a test body, and fileURLToPath rejects
// the latter. A plain path string has no such ambiguity.
const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../../public");

const read = (p) => readFileSync(path.join(PUBLIC_DIR, p), "utf8");

let applyTheme, THEMES, DEFAULT_THEME;

const loadModule = async () => {
  vi.resetModules();
  const mod = await import("../../../public/js/ui/theme.js");
  ({ applyTheme, THEMES, DEFAULT_THEME } = mod);
  return mod;
};

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  await loadModule();
});

describe("theme", () => {
  describe("THEMES registry", () => {
    it("exposes every selectable theme with an id, label and dark flag", () => {
      expect(THEMES.length).toBeGreaterThanOrEqual(2);
      for (const t of THEMES) {
        expect(t).toMatchObject({
          id: expect.any(String),
          label: expect.any(String),
          dark: expect.any(Boolean),
        });
      }
    });

    it("has no duplicate ids", () => {
      const ids = THEMES.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("includes the default theme", () => {
      expect(THEMES.some((t) => t.id === DEFAULT_THEME)).toBe(true);
    });

    // The registry, the CSS and the picker have to stay in step, so a theme
    // added to one but not the others fails here rather than at runtime.
    it("matches the palettes declared in themes.css", () => {
      const css = read("css/core/themes.css");
      const inCss = [...css.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map((m) => m[1]);
      // The default lives in variables.css as :root, so it has no block here.
      expect(THEMES.map((t) => t.id).filter((id) => id !== DEFAULT_THEME).sort())
        .toEqual([...new Set(inCss)].sort());
    });

    // The picker renders its options from THEMES, so there is no hand-written
    // option list left to drift. Guard that the old duplicated markup is gone.
    it("leaves no stale theme picker markup in index.html", () => {
      const html = read("index.html");
      expect(html).not.toContain('id="theme-select"');
      expect(html).not.toContain('data-target="theme-select"');
      expect(html).not.toContain('id="theme-toggle-btn"');
    });
  });

  describe("applyTheme", () => {
    it("sets data-theme attribute on document element", () => {
      applyTheme("light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });

    it("persists theme to localStorage", () => {
      applyTheme("dark");
      expect(localStorage.getItem("claudeck-theme")).toBe("dark");
    });

    it("applies each registered theme by id", () => {
      for (const t of THEMES) {
        applyTheme(t.id);
        expect(document.documentElement.getAttribute("data-theme")).toBe(t.id);
      }
    });

    it("falls back to the first theme for an unknown id", () => {
      applyTheme("no-such-theme");
      expect(document.documentElement.getAttribute("data-theme")).toBe(THEMES[0].id);
      expect(localStorage.getItem("claudeck-theme")).toBe(THEMES[0].id);
    });

    it("returns the resolved theme", () => {
      expect(applyTheme("nord")).toMatchObject({ id: "nord" });
    });

    // Previously this tested `theme === "light"`, so every theme other than
    // that one got the dark stylesheet regardless of how light its palette was.
    it.each([
      ["light", "github.min.css"],
      ["flatly", "github.min.css"],
      ["dark", "github-dark.min.css"],
      ["darkly", "github-dark.min.css"],
      ["nord", "github-dark.min.css"],
    ])("picks the hljs stylesheet matching %s", (id, expected) => {
      const link = document.createElement("link");
      link.id = "hljs-theme";
      document.head.appendChild(link);

      applyTheme(id);
      expect(link.href).toContain(expected);
      if (expected === "github.min.css") expect(link.href).not.toContain("github-dark");

      link.remove();
    });

    it("does not throw when hljs-theme link is absent", () => {
      expect(() => applyTheme("dark")).not.toThrow();
    });

    it("leaves the PWA theme-color meta intact when --bg cannot be resolved", () => {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = "#0d1117";
      document.head.appendChild(meta);
      // happy-dom loads no stylesheets, so --bg is empty; the guard must keep
      // the existing value rather than blanking the tag.
      applyTheme("flatly");
      expect(meta.getAttribute("content")).toBe("#0d1117");
      meta.remove();
    });
  });

  describe("init", () => {
    it("applies the default theme when nothing is saved", async () => {
      localStorage.clear();
      await loadModule();
      expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);
    });

    it("applies a saved theme from localStorage on load", async () => {
      localStorage.setItem("claudeck-theme", "darkly");
      await loadModule();
      expect(document.documentElement.getAttribute("data-theme")).toBe("darkly");
    });

    it("ignores a saved theme that no longer exists", async () => {
      localStorage.setItem("claudeck-theme", "removed-theme");
      await loadModule();
      expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);
    });
  });
});
