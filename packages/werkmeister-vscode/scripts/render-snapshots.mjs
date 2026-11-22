// SW-1019: the Workspaces view's strip and cards, quiet and busy, as static pages drawn with the view's own CSS
// and VS Code's Dark Modern colours, so a layout is measured at spec time, not first in the exercise.
// Run after `tsc` (it reads out/): `pnpm --filter werkmeister-vscode run snapshots [out dir]`.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTree, stripOf } from "../out/build-tree.js";
import { renderCards } from "../out/cards.js";
import { VIEW_CSS } from "../out/view-css.js";
import { snapshot } from "./snapshot-fixture.mjs";

/** Dark Modern's value for every theme variable the view's CSS reads. */
const DARK_MODERN = {
  "--vscode-font-family":
    '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-disabledForeground": "#cccccc80",
  "--vscode-errorForeground": "#f85149",
  "--vscode-sideBar-background": "#181818",
  "--vscode-badge-background": "#616161",
  "--vscode-badge-foreground": "#f8f8f8",
  "--vscode-button-background": "#0078d4",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-border": "#ffffff12",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-button-secondaryHoverBackground": "#3c3c3c",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-textLink-activeForeground": "#4daafc",
  "--vscode-charts-blue": "#3794ff",
  "--vscode-charts-green": "#89d185",
  "--vscode-charts-yellow": "#cca700",
  "--vscode-charts-purple": "#b180d7",
};

/** One snapshot as the page the webview would hold: a sidebar's background, the view's CSS, the posted HTML. */
export function page(kind) {
  const s = snapshot(kind);
  const names = s.statuses.map((w) => w.name);
  const extra = {
    prs: new Map(Object.entries(s.prs)),
    host: s.host,
    infra: s.infra,
    now: s.now,
  };
  const workspaces = names.map((name) => ({
    name,
    path: `/fixture/${name}`,
    issueId: null,
    issueUrl: null,
    labels: [],
  }));
  const nodes = buildTree(workspaces, s.statuses, null, [], extra);
  const html = renderCards(nodes, { strip: stripOf(nodes, s.statuses, extra) });
  const vars = Object.entries(DARK_MODERN)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Workspaces view: ${kind}</title>
<style>:root{${vars}}html,body{margin:0;background:var(--vscode-sideBar-background)}${VIEW_CSS}</style>
</head>
<body><main id="root">${html}</main></body>
</html>
`;
}

/** Writes quiet.html and busy.html into `dir`; returns their paths. */
export function writeSnapshots(dir) {
  mkdirSync(dir, { recursive: true });
  return ["quiet", "busy"].map((kind) => {
    const file = join(dir, `${kind}.html`);
    writeFileSync(file, page(kind));
    return file;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of writeSnapshots(resolve(process.argv[2] ?? join(here, "../out/snapshots"))))
    console.log(f);
}
