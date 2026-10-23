/**
 * Shared UI foundation for every dashboard surface: the design tokens
 * (tokens.css, CSS custom properties on :root) and the page mount point.
 * `Css` (style.tsx) is re-exported for the dashboard tabs.
 *
 * Tokens are prefixed `--sd-` so they can never collide with host-provided
 * variables (the ext-apps webview applies the host's own CSS variables to
 * the same document root).
 */

import "./tokens.css";

export { Css } from "./style.js";

/** The page's `#app` mount point; every surface's HTML shell provides one. */
export function appRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (!root) throw new Error("this page has no #app element to mount into");
  return root;
}
