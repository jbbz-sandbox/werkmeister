// Theme registry + switching. Palettes live in css/core/themes.css.
// The picker lives in the Settings modal (components/settings-modal.js), which
// renders its options from THEMES and calls applyTheme on change.

// `dark` is not the palette — it only picks the highlight.js and Mermaid
// variant that reads correctly on that palette. Adding a theme means adding
// a block to themes.css, an entry here, and a submenu button in index.html.
export const THEMES = [
  { id: "dark",   label: "Midnight", dark: true  },
  { id: "light",  label: "Paper",    dark: false },
  { id: "flatly", label: "Flatly",   dark: false },
  { id: "darkly", label: "Darkly",   dark: true  },
  { id: "nord",   label: "Nord",     dark: true  },
];

export const DEFAULT_THEME = "dark";

const hljsHref = (dark) =>
  `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github${dark ? "-dark" : ""}.min.css`;

export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];

  document.documentElement.dataset.theme = theme.id;
  localStorage.setItem("claudeck-theme", theme.id);

  if (typeof mermaid !== "undefined") {
    mermaid.initialize({ startOnLoad: false, theme: theme.dark ? "dark" : "default" });
  }

  const hljsLink = document.getElementById("hljs-theme");
  if (hljsLink) hljsLink.href = hljsHref(theme.dark);

  // Keep the PWA / mobile browser chrome in step with the palette
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (bg) meta.setAttribute("content", bg);
  }

  return theme;
}

// Initialize from localStorage, falling back to the default for unknown ids
// (e.g. a theme dropped from themes.css after someone had it selected).
const saved = localStorage.getItem("claudeck-theme");
applyTheme(THEMES.some((t) => t.id === saved) ? saved : DEFAULT_THEME);
