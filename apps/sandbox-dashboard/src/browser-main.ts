/**
 * Plain-browser entrypoint for the Sandbox Workspaces dashboard — the fallback
 * surface for MCP hosts that don't render `ui://` resources (Claude Code CLI,
 * the VS Code extension).
 *
 * The dashboard is a five-tab shell:
 *   • Workspaces          — the shared list UI (src/workspace-ui.ts)
 *   • New workspace       — the create form (src/create-form.ts)
 *   • Open Pull Requests  — the PR review tab (src/prs-ui.ts)
 *   • Health              — infra/k8s/kube status (src/health-ui.ts)
 *   • Links               — sandbox feature-selector links (src/sandbox-links-ui.ts)
 * All drive their tool calls through the same bridge (same-origin `POST
 * /api/tool`, dispatched into the real MCP tools by lib/browser-ui.ts).
 *
 * Built to dist/browser.html and served by lib/browser-ui.ts.
 */

import { renderMarkdown } from "../lib/markdown.js";
import { initCreateForm } from "./create-form.js";
import { initHealthUI } from "./health-ui.js";
import { initPrsUI } from "./prs-ui.js";
import { initSandboxLinksUI } from "./sandbox-links-ui.js";
import { injectCss } from "./theme.js";
import { type HostBridge, initWorkspaceUI } from "./workspace-ui.js";

const bridge: HostBridge = {
  async callTool(name, args) {
    const r = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args ?? {} }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `${name} failed`);
    return d.structuredContent ?? JSON.parse(d.content?.[0]?.text ?? "null");
  },
  openLink(url) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  },
  // Browser-only: live session stream over SSE (lib/browser-ui.ts serves the
  // route). EventSource auto-reconnects with Last-Event-ID, so backfill already
  // sent is skipped on reconnect. The inline + artifact surfaces omit this.
  streamSession(name, h, fromIndex, sessionId) {
    let q = `name=${encodeURIComponent(name)}&from=${fromIndex ?? 0}`;
    if (sessionId) q += `&session=${encodeURIComponent(sessionId)}`;
    const es = new EventSource(`/api/session/stream?${q}`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "entry") h.onEntry(e.index, e.message);
      else if (e.type === "turn") h.onTurn(e.state, e.error);
      else if (e.type === "ready") h.onReady(e);
    };
    return () => es.close();
  },
};

const SHELL_CSS = `
  /* One bounded-wide column shared by the header, tabs, and both panes so the
     two tabs read as one product on a wide screen (full-bleed at 1680px+ left
     badges stranded). Bump to 1320px if it feels tight on an ultrawide. */
  .wsd-container { max-width: 1200px; margin: 0 auto; width: 100%; }
  .wsd-tabs {
    padding: 10px 0 0; background: var(--sd-bg);
    border-bottom: 1px solid var(--sd-line); position: sticky; top: 0; z-index: 5;
    font-family: var(--sd-sans);
  }
  .wsd-tabrow { display: flex; gap: 4px; padding: 0 20px; }
  .wsd-tab {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 8px 14px; border: none; border-bottom: 2px solid transparent;
    background: transparent; color: var(--sd-muted); border-radius: 6px 6px 0 0;
  }
  .wsd-tab:hover { color: var(--sd-ink); background: var(--sd-hover); }
  .wsd-tab.active { color: var(--sd-ink); border-bottom-color: var(--sd-accent); }
  .wsd-pane[hidden] { display: none; }
  body { margin: 0; background: var(--sd-bg); }
`;

const root = document.getElementById("app")!;
injectCss("wsd-shell", SHELL_CSS);

root.innerHTML = `
  <div class="wsd-header wsd-container" data-id="shell-header"></div>
  <div class="wsd-tabs">
    <div class="wsd-tabrow wsd-container">
      <button class="wsd-tab active" data-tab="list">Workspaces</button>
      <button class="wsd-tab" data-tab="new">New workspace</button>
      <button class="wsd-tab" data-tab="prs">Open Pull Requests</button>
      <button class="wsd-tab" data-tab="health">Health</button>
      <button class="wsd-tab" data-tab="links">Links</button>
    </div>
  </div>
  <div class="wsd-pane wsd-container" data-pane="list"></div>
  <div class="wsd-pane wsd-container" data-pane="new" hidden></div>
  <div class="wsd-pane wsd-container" data-pane="prs" hidden></div>
  <div class="wsd-pane wsd-container" data-pane="health" hidden></div>
  <div class="wsd-pane wsd-container" data-pane="links" hidden></div>
`;

const shellHeader = root.querySelector('[data-id="shell-header"]') as HTMLElement;
const listPane = root.querySelector('[data-pane="list"]') as HTMLElement;
const newPane = root.querySelector('[data-pane="new"]') as HTMLElement;
const prsPane = root.querySelector('[data-pane="prs"]') as HTMLElement;
const healthPane = root.querySelector('[data-pane="health"]') as HTMLElement;
const linksPane = root.querySelector('[data-pane="links"]') as HTMLElement;
const tabs = [...root.querySelectorAll<HTMLButtonElement>(".wsd-tab")];

// Lift the header (title + infra/k8s/kube topbar) into the shell so it persists
// while filling out the New-workspace form.
const list = initWorkspaceUI(bridge, listPane, { headerRoot: shellHeader, renderMarkdown });
let createMounted = false;
let prsMounted = false;
let prs: { reload: () => void } | null = null;
let healthMounted = false;
let health: { reload: () => void } | null = null;
let linksMounted = false;

// Each top-level tab is a page addressed by the URL hash (…/#list, …/#new), so
// tabs are deep-linkable and the browser Back/Forward buttons move between them.
// `show` only renders; `navigate` changes the hash, and the hashchange listener
// is the single place that drives rendering — so a click, a deep link, and a
// Back-button pop all flow through the same path.
type Tab = "list" | "new" | "prs" | "health" | "links";

const TAB_TITLES: Record<Tab, string> = {
  list: "Sandbox Workspaces",
  new: "New workspace · Sandbox Workspaces",
  prs: "Open Pull Requests · Sandbox Workspaces",
  health: "Health · Sandbox Workspaces",
  links: "Links · Sandbox Workspaces",
};

function show(tab: Tab): void {
  tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  listPane.hidden = tab !== "list";
  newPane.hidden = tab !== "new";
  prsPane.hidden = tab !== "prs";
  healthPane.hidden = tab !== "health";
  linksPane.hidden = tab !== "links";
  document.title = TAB_TITLES[tab];
  if (tab === "new" && !createMounted) {
    createMounted = true;
    initCreateForm(bridge, newPane, {
      onCreated: () => {
        list.reload();
        navigate("list");
      },
    });
  }
  if (tab === "prs" && !prsMounted) {
    prsMounted = true;
    prs = initPrsUI(bridge, prsPane);
  }
  if (tab === "health") {
    if (!healthMounted) {
      healthMounted = true;
      health = initHealthUI(bridge, healthPane);
    } else health?.reload();
  }
  if (tab === "links" && !linksMounted) {
    linksMounted = true;
    initSandboxLinksUI(bridge, linksPane);
  }
}

function tabFromHash(): Tab {
  const h = location.hash.replace(/^#/, "");
  return h === "new" || h === "prs" || h === "health" || h === "links" ? h : "list";
}

function navigate(tab: Tab): void {
  // Setting the hash adds a history entry and fires hashchange (which renders).
  // If we're already on that hash there's no event, so render directly.
  if (tabFromHash() === tab) show(tab);
  else location.hash = tab;
}

tabs.forEach((b) => b.addEventListener("click", () => navigate(b.dataset.tab as Tab)));
window.addEventListener("hashchange", () => show(tabFromHash()));

// Initial render honors a deep link (…/#new); default is the list.
show(tabFromHash());
