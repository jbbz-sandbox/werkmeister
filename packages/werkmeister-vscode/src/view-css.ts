/** The Workspaces view's stylesheet, kept apart from view.ts so a script can render it without `vscode` (SW-1019). */
import { CARD_CSS } from "./cards.js";

/** `.w0{width:0%}` … `.w10{width:100%}`: the meter widths cards.ts names by class. */
const METER_WIDTHS = Array.from({ length: 11 }, (_, i) => `.w${i}{width:${i * 10}%}`).join("");

/** Theme variables only, so the cards follow whatever theme is active, live. */
export const VIEW_CSS = `
body{padding:4px 0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
/* Tiles, bordered in a mix of the text colour: a theme's own panel border is often too faint to part them. */
.card{margin:0 8px 8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--vscode-foreground) 18%,transparent);border-radius:6px;display:flex;flex-direction:column;gap:3px}
/* SW-864: the tile whose session is in the active terminal. */
.card.in-terminal{border-color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 10%,transparent)}
.chip{margin-left:auto;padding:0 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;font-weight:600;white-space:nowrap}
.card .row:has(.chip){flex-wrap:nowrap}
.card .row:has(.chip) .name{min-width:0}
.row{display:flex;flex-wrap:wrap;gap:2px 12px;align-items:baseline}
.name{font-weight:600}
.card,.name{overflow-wrap:anywhere}
.dim{color:var(--vscode-descriptionForeground)}
.pre{white-space:pre-wrap}
.svc{white-space:nowrap}
a{color:var(--vscode-textLink-foreground);text-decoration:none}
a:hover{color:var(--vscode-textLink-activeForeground);text-decoration:underline}
button{margin-top:2px;padding:3px 10px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
a.name{color:inherit}
a.name:hover{color:var(--vscode-textLink-activeForeground)}
a:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
/* SW-961: one segment per stage; theme colours only, so it follows the theme. */
.stages{display:flex;gap:3px;margin:3px 0}
.stages span{flex:1;height:5px;border-radius:3px;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}
.stages .done{background:var(--vscode-charts-blue)}
.stages .current{background:color-mix(in srgb,var(--vscode-charts-blue) 40%,transparent)}
/* SW-1009: the strip stays pinned while the cards scroll under it; 2 rows at most: chips scroll sideways rather than wrap. */
.strip{position:sticky;top:0;z-index:1;margin:0 0 8px;padding:4px 12px;background:var(--vscode-sideBar-background);display:flex;flex-direction:column;gap:2px}
.strip .host{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.strip .chips{display:flex;gap:10px;white-space:nowrap;overflow-x:auto;scrollbar-width:thin}
.meter{position:relative;flex:none;width:48px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--vscode-foreground) 18%,transparent)}
.meter span{position:absolute;left:0;top:0;bottom:0;border-radius:3px}
.m-host{background:color-mix(in srgb,var(--vscode-charts-blue) 40%,transparent)}
.m-feat{background:var(--vscode-charts-blue)}
${METER_WIDTHS}
@media (max-width:260px){.meter{display:none}}
${CARD_CSS}`;
