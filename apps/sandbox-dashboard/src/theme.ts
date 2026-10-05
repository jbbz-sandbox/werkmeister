/**
 * Shared UI foundation for every dashboard surface: the design tokens (CSS
 * custom properties on :root), a one-per-id style injector, and the `el()`
 * DOM helper. Dependency-free on purpose — workspace-ui.ts pulls this into
 * the strict-CSP Cowork artifact bundle.
 *
 * Tokens are prefixed `--sd-` so they can never collide with host-provided
 * variables (the ext-apps webview applies the host's own CSS variables to
 * the same document root).
 */

export const THEME_CSS = `
  :root {
    --sd-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --sd-mono: ui-monospace, SFMono-Regular, Menlo, monospace;

    /* Surfaces */
    --sd-bg: #f7f7f5;        /* page background */
    --sd-card: #fff;         /* card / control background */
    --sd-soft: #fafaf8;      /* row hover, nested-row background */
    --sd-hover: #f2f2ef;     /* button hover background */

    /* Text */
    --sd-ink: #1a1a1a;       /* primary */
    --sd-muted: #6b6b66;     /* secondary */
    --sd-faint: #8a8a84;     /* tertiary */
    --sd-ghost: #b0b0aa;     /* disabled / placeholder / empty */

    /* Lines */
    --sd-line: #e5e5e0;      /* card borders */
    --sd-line-soft: #f0f0ec; /* inner separators, neutral chip bg */
    --sd-ctl-border: #d8d8d2;/* input / button borders */

    /* Brand accent (primary actions, focus, active tab) */
    --sd-accent: #d97757;
    --sd-accent-hover: #c56647;

    /* Semantic: good / caution / bad / informational (Jira, links) */
    --sd-ok: #1e7a46;       --sd-ok-bg: #e9f7ef;   --sd-ok-dot: #29a35a;  --sd-ok-border: #b7e4c7;
    --sd-warn: #b76a00;     --sd-warn-bg: #fff4e5; --sd-warn-dot: #e0932f;
    --sd-err: #c0392b;      --sd-err-bg: #fdecea;  --sd-err-border: #f3c0c0;
    --sd-info: #1d5fd6;     --sd-info-bg: #e7f0ff;
  }

  /* Kube environment pill — shared by the topbar (workspace-ui) and Health tab. */
  .kube-env {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 2px 7px; border-radius: 999px;
  }
  .kube-env.dev { background: var(--sd-ok-bg); color: var(--sd-ok); }
  .kube-env.stage { background: var(--sd-warn-bg); color: var(--sd-warn); }
  .kube-env.prod { background: var(--sd-err-bg); color: var(--sd-err); }
  .kube-env.other { background: var(--sd-line-soft); color: var(--sd-muted); }
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

/** Inject a component's CSS once per id; the theme tokens always ride along. */
export function injectCss(id: string, css: string): void {
  addStyle("theme", THEME_CSS);
  addStyle(id, css);
}

/** The shared vanilla-DOM element helper (see workspace-ui.ts header note). */
export function el(tag: string, cls?: string | null, txt?: string | null): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
