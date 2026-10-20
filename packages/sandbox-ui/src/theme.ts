/**
 * Shared UI foundation for every dashboard surface: the design tokens
 * (tokens.css, CSS custom properties on :root), a one-per-id style injector,
 * and the `el()` DOM helper.
 *
 * Tokens are prefixed `--sd-` so they can never collide with host-provided
 * variables (the ext-apps webview applies the host's own CSS variables to
 * the same document root).
 */

import "./tokens.css";

export const THEME_CSS = `
  /* Kube environment pill — shared by the topbar (workspace-ui) and Health tab. */
  .kube-env {
    font: 600 11px var(--sd-mono); text-transform: uppercase; letter-spacing: 0.06em;
    padding: 1px 6px; border-radius: 3px; border: 1px solid;
  }
  .kube-env.dev { background: var(--sd-ok-bg); color: var(--sd-ok); border-color: var(--sd-ok-bd); }
  .kube-env.stage { background: var(--sd-warn-bg); color: var(--sd-warn); border-color: var(--sd-warn-bd); }
  .kube-env.prod { background: var(--sd-err-bg); color: var(--sd-err); border-color: var(--sd-err-bd); }
  .kube-env.other { background: var(--sd-off-bg); color: var(--sd-off); border-color: var(--sd-off-bd); }
`;

const injected = new Set<string>();

function addStyle(id: string, css: string): void {
  if (injected.has(id)) return;
  injected.add(id);
  const style = document.createElement("style");
  style.dataset.sdCss = id;
  style.textContent = css;
  document.head.appendChild(style);
}

/** Inject a component's CSS once per id, plus the shared theme rules. */
export function injectCss(id: string, css: string): void {
  addStyle("theme", THEME_CSS);
  addStyle(id, css);
}

/** The page's `#app` mount point; every surface's HTML shell provides one. */
export function appRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (!root) throw new Error("this page has no #app element to mount into");
  return root;
}

/** The shared vanilla-DOM element helper (see workspace-ui.ts header note). */
export function el(tag: string, cls?: string | null, txt?: string | null): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
