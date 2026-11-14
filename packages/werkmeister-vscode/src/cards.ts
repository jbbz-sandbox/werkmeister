/**
 * The Workspaces view as wrapping cards: WsNode[] in, one HTML string out.
 *
 * Free of any `vscode` import, like build-tree.ts, so it runs under `node --test`.
 * Every value is escaped: names, labels and the agent's question are not ours.
 * No inline styles, since the view's CSP allows only the nonce'd stylesheet;
 * a colour is the class `colorClass` names.
 */
import { RELEASED_COLOR, TONE_COLORS, type WsNode } from "./build-tree.js";

/** The only commands a click in the view may run; view.ts trusts exactly these. */
export const CARD_COMMANDS = [
  "sandbox.openIssue",
  "sandbox.openPr",
  "sandbox.openTerminal",
  "sandbox.startWork",
  "sandbox.pause",
  "sandbox.resume",
  "sandbox.masterControl",
  "sandbox.dashboard",
  "sandbox.configure",
];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `charts.green` → `c-charts-green`, the class CARD_CSS gives `var(--vscode-charts-green)`. */
function colorClass(id?: string): string {
  return id ? `c-${id.replace(/\./g, "-")}` : "";
}

/** One rule per tone colour, in the theme's own variables so the cards follow it. */
export const CARD_CSS = [...new Set([...Object.values(TONE_COLORS), RELEASED_COLOR])]
  .map((id) => `.${colorClass(id)}{color:var(--vscode-${id.replace(/\./g, "-")})}`)
  .join("\n");

/**
 * What a right-click passes the command: the fields pickWorkspace() and the service
 * and PR commands read off a node. `webviewSection` is the node's contextValue, so the
 * `webview/context` clauses in package.json match it as `viewItem` clauses did.
 */
function context(n: WsNode): string {
  const data = {
    webviewSection: n.contextValue,
    preventDefaultContextMenuItems: true,
    workspace: n.workspace,
    service: n.service,
    pr: n.pr,
  };
  return ` data-vscode-context="${esc(JSON.stringify(data))}"`;
}

function action(tag: "a" | "button", command: string, id: string, label: string): string {
  const attrs = `data-cmd="${command}" data-id="${esc(id)}"`;
  return tag === "a"
    ? `<a href="#" ${attrs}>${esc(label)}</a>`
    : `<button type="button" ${attrs}>${esc(label)}</button>`;
}

function line(cls: string, text: string | null | undefined): string {
  return text ? `<div class="${cls}">${esc(text)}</div>` : "";
}

/** The run's own verb (build-tree's `sessionAction`); containers are left to the right-click menu. */
const SESSION_BUTTON = {
  start: ["sandbox.startWork", "▶ Start work"],
  pause: ["sandbox.pause", "⏸ Pause"],
  resume: ["sandbox.resume", "▶ Resume"],
} as const;

function workspaceCard(n: WsNode): string {
  const card = n.card;
  if (!card) return "";
  const services = n.children.filter((c) => c.kind === "service");
  const prs = n.children.filter((c) => c.kind === "pr");
  const issue = card.issueId
    ? n.workspace?.issueUrl
      ? action("a", "sandbox.openIssue", n.id, `${card.issueId} ↗`)
      : `<span>${esc(card.issueId)}</span>`
    : "";
  // One line each: the issue, then every PR with its state and CI in their own colours.
  const links = [
    issue,
    ...prs.map((p) => {
      const status = (p.pr?.status ?? [])
        .map((s) => `<span class="${colorClass(s.color)}">${esc(s.text)}</span>`)
        .join(" · ");
      return `${action("a", "sandbox.openPr", p.id, `${p.label} ↗`)} ${status}`;
    }),
  ].filter(Boolean);
  return [
    `<article class="card"${context(n)}>`,
    `<div class="row"><span class="name">${esc(n.label)}</span><span class="${colorClass(n.icon.color)}">${esc(card.state)}</span></div>`,
    line(colorClass(card.activity?.color), card.activity?.text),
    card.question ? `<blockquote>“${esc(card.question)}”</blockquote>` : "",
    line(colorClass(TONE_COLORS.err), card.crash),
    line("dim", card.meta),
    links.map((l) => `<div>${l}</div>`).join(""),
    services.length
      ? `<div class="row">${services
          .map(
            (s) =>
              `<span class="svc"${context(s)}><span class="${colorClass(s.icon.color)}">${esc(s.glyph ?? "")}</span> ${esc(s.label)} <span class="dim">${esc(s.description)}</span></span>`,
          )
          .join("")}</div>`
      : "",
    `<div class="row">${action("button", "sandbox.openTerminal", n.id, "Open terminal")}${card.action ? action("button", SESSION_BUTTON[card.action][0], n.id, SESSION_BUTTON[card.action][1]) : ""}</div>`,
    "</article>",
  ].join("");
}

/** Host, legend and error rows: a label, its description, and the click the node carries. */
function plainCard(n: WsNode): string {
  const label =
    n.command && CARD_COMMANDS.includes(n.command)
      ? action("a", n.command, n.id, n.label)
      : `<span class="name ${colorClass(n.icon.color)}">${esc(n.label)}</span>`;
  return [
    `<article class="card">`,
    `<div class="row">${label}<span class="dim">${esc(n.description)}</span></div>`,
    n.kind === "error" ? line("dim pre", n.tooltip) : "",
    n.children
      .map(
        (c) =>
          `<div class="row"><span class="${colorClass(c.icon.color)}">${esc(c.label)}</span><span class="dim">${esc(c.description)}</span></div>`,
      )
      .join(""),
    "</article>",
  ].join("");
}

export function renderCards(nodes: WsNode[]): string {
  return [
    `<div class="top row">${action("button", "sandbox.masterControl", "", "Master control")}${action("button", "sandbox.dashboard", "", "Dashboard ↗")}</div>`,
    ...nodes.map((n) => (n.kind === "workspace" ? workspaceCard(n) : plainCard(n))),
  ].join("");
}

/** Depth-first by id: a click names its node by id and never carries the node itself. */
export function findNode(nodes: WsNode[], id: string): WsNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}
