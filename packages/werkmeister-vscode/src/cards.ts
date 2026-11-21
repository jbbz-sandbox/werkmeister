/**
 * The Workspaces view as wrapping cards: WsNode[] in, one HTML string out.
 *
 * Free of any `vscode` import, like build-tree.ts, so it runs under `node --test`.
 * Every value is escaped: names, labels and the agent's question are not ours.
 * No inline styles, since the view's CSP allows only the nonce'd stylesheet;
 * a colour is the class `colorClass` names.
 */
import {
  type InTerminal,
  RELEASED_COLOR,
  TONE_COLORS,
  type WsCard,
  type WsNode,
} from "./build-tree.js";

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
  "sandbox.openBoard",
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

function action(
  tag: "a" | "button",
  command: string,
  id: string,
  label: string,
  extra = "",
): string {
  const attrs = `data-cmd="${command}" data-id="${esc(id)}"${extra}`;
  return tag === "a"
    ? `<a href="#" ${attrs}>${esc(label)}</a>`
    : `<button type="button" ${attrs}>${esc(label)}</button>`;
}

/** The pill on whichever tile the active terminal is showing (SW-864). */
const CHIP = `<span class="chip">In terminal</span>`;

/** The hover names where the link goes: Jira, GitHub, else the host. */
function trackerName(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith("atlassian.net")) return "Jira";
    if (host === "github.com") return "GitHub";
    return host;
  } catch {
    return "the tracker";
  }
}

function line(cls: string, text: string | null | undefined): string {
  return text ? `<div class="${cls}">${esc(text)}</div>` : "";
}

/** SW-961: one segment per stage, like a GitHub Actions job bar; the count is in the hover and for screen readers. */
function stagesBar(pips: WsCard["pips"]): string {
  if (!pips.length) return "";
  const done = pips.filter((p) => p === "done").length;
  const label = `${done} of ${pips.length} stages done`;
  // The pips are the display model's fixed literals, so they need no escaping.
  return `<div class="stages" role="progressbar" aria-label="Stages" aria-valuemin="0" aria-valuemax="${pips.length}" aria-valuenow="${done}" aria-valuetext="${label}" title="${label}">${pips.map((p) => `<span class="${p}"></span>`).join("")}</div>`;
}

/** The run's own verb (build-tree's `sessionAction`); containers are left to the right-click menu. */
const SESSION_BUTTON = {
  start: ["sandbox.startWork", "▶ Start work"],
  pause: ["sandbox.pause", "⏸ Pause"],
  resume: ["sandbox.resume", "▶ Resume"],
} as const;

function workspaceCard(n: WsNode, active: boolean): string {
  const card = n.card;
  if (!card) return "";
  const services = n.children.filter((c) => c.kind === "service");
  const prs = n.children.filter((c) => c.kind === "pr");
  const url = n.workspace?.issueUrl;
  // The name is the issue link (SW-864); its hover says where it goes.
  const name = url
    ? action(
        "a",
        "sandbox.openIssue",
        n.id,
        n.label,
        ` class="name" title="Open ${esc(card.issueId ?? n.label)} in ${esc(trackerName(url))}"`,
      )
    : `<span class="name">${esc(n.label)}</span>`;
  // One line each: every PR with its state and CI in their own colours.
  const links = prs.map((p) => {
    const status = (p.pr?.status ?? [])
      .map((s) => `<span class="${colorClass(s.color)}">${esc(s.text)}</span>`)
      .join(" · ");
    return `${action("a", "sandbox.openPr", p.id, `${p.label} ↗`)} ${status}`;
  });
  const open = card.needsYou
    ? action("button", "sandbox.openTerminal", n.id, "Answer in terminal", ` class="primary"`)
    : action("button", "sandbox.openTerminal", n.id, "Open terminal");
  return [
    `<article class="card${active ? " in-terminal" : ""}" id="ws-${esc(n.id)}"${context(n)}>`,
    `<div class="row">${name}<span class="${colorClass(n.icon.color)}">${esc(card.state)}</span>${active ? CHIP : ""}</div>`,
    line("dim", card.meta),
    stagesBar(card.pips),
    line(colorClass(card.activity?.color), card.activity?.text),
    card.question ? `<blockquote>“${esc(card.question)}”</blockquote>` : "",
    line(colorClass(TONE_COLORS.err), card.crash),
    links.map((l) => `<div>${l}</div>`).join(""),
    services.length
      ? `<div class="row">${services
          .map(
            (s) =>
              `<span class="svc"${context(s)}><span class="${colorClass(s.icon.color)}">${esc(s.glyph ?? "")}</span> ${esc(s.label)} <span class="dim">${esc(s.description)}</span></span>`,
          )
          .join("")}</div>`
      : "",
    `<div class="row">${open}${card.action ? action("button", SESSION_BUTTON[card.action][0], n.id, SESSION_BUTTON[card.action][1]) : ""}</div>`,
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

export interface RenderOptions {
  /** The tile the active terminal is showing; it alone gets the cue. */
  inTerminal?: InTerminal;
  /** The Jira board link; no button without one. */
  board?: string | null;
}

/** `● 2 need you · 1 PR to review`, each linking to the first card it counts. */
function summary(nodes: WsNode[]): string {
  const ws = nodes.filter((n) => n.kind === "workspace");
  const needs = ws.filter((n) => n.card?.needsYou);
  const review = ws.filter((n) => n.children.some((c) => c.pr?.open));
  const count = (list: WsNode[], one: string, many: string, cls: string) =>
    list.length
      ? `<a href="#ws-${esc(list[0].id)}"${cls}>${list.length} ${list.length === 1 ? one : many}</a>`
      : "";
  const parts = [
    count(needs, "needs you", "need you", ` class="${colorClass(TONE_COLORS.needs)}"`),
    count(review, "PR to review", "PRs to review", ""),
  ].filter(Boolean);
  return parts.length ? `<div>${parts.join(`<span class="dim"> · </span>`)}</div>` : "";
}

function masterControl(nodes: WsNode[], o: RenderOptions): string {
  const active = o.inTerminal?.kind === "root";
  return [
    `<section class="card master${active ? " in-terminal" : ""}" aria-label="Master control">`,
    `<div class="row"><span class="name">Master control</span>${active ? CHIP : ""}</div>`,
    `<div class="dim">Triage, backlog and close-out</div>`,
    summary(nodes),
    `<div class="row">`,
    action("button", "sandbox.masterControl", "", "Master control", ` class="primary"`),
    action("button", "sandbox.dashboard", "", "Dashboard ↗"),
    o.board
      ? action("button", "sandbox.openBoard", "", "Jira board ↗", ` title="${esc(o.board)}"`)
      : "",
    `</div>`,
    `</section>`,
  ].join("");
}

export function renderCards(nodes: WsNode[], o: RenderOptions = {}): string {
  const t = o.inTerminal;
  return [
    masterControl(nodes, o),
    ...nodes.map((n) =>
      n.kind === "workspace"
        ? workspaceCard(n, t?.kind === "workspace" && t.name === n.workspace?.name)
        : plainCard(n),
    ),
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
