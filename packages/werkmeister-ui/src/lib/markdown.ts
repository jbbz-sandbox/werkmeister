/**
 * Shared markdown-it renderer for the browser dashboard's PR bodies.
 *
 * `html: false` escapes any raw HTML in the untrusted PR body instead of passing
 * it through — that single flag is the XSS-safety invariant (no separate
 * sanitizer needed). `linkify: true` turns bare URLs into links.
 *
 * Lives in lib/ (not inline in prs-ui.ts) so the compiled dist/lib/markdown.js is
 * importable by lib/open-prs.smoke.mjs, which locks in this config. Only prs-ui.ts
 * (browser bundle) imports it at runtime — the strict-CSP MCP App (mcp-list.html) does not.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true });

/** Render CommonMark/GFM to HTML with raw HTML escaped. Safe to assign via innerHTML. */
export function renderMarkdown(src: string): string {
  return md.render(src ?? "");
}
