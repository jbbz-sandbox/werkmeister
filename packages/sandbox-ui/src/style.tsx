/**
 * The `Css` stylesheet component and the theme rules every surface shares. No
 * tokens.css import, so node can render components that use it (tests); theme.tsx
 * adds the tokens for the bundles.
 */

const THEME_CSS = `
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

/**
 * A component's stylesheet plus the shared theme rules. React 19 hoists a `<style>`
 * with `href` + `precedence` into <head> and keeps one per href, however many
 * components render it.
 */
export function Css({ id, css }: { id: string; css: string }) {
  return (
    <>
      <style href="sd-theme" precedence="sd">
        {THEME_CSS}
      </style>
      <style href={`sd-${id}`} precedence="sd">
        {css}
      </style>
    </>
  );
}
