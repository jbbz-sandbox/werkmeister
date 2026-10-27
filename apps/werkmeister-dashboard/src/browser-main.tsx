/**
 * Plain-browser entrypoint for the Werkmeister Workspaces dashboard — the fallback
 * surface for MCP hosts that don't render `ui://` resources (Claude Code CLI,
 * the VS Code extension).
 *
 * The dashboard is a five-tab shell:
 *   • Workspaces          — the shared list UI (werkmeister-ui/workspace-ui)
 *   • New workspace       — the create form (werkmeister-ui/create-form)
 *   • Open Pull Requests  — the PR review tab (prs-ui.tsx)
 *   • Health              — infra/k8s/kube status (health-ui.tsx)
 *   • Links               — werkmeister feature-selector links (werkmeister-links-ui.tsx)
 * All drive their tool calls through the same bridge (same-origin `POST
 * /api/tool`, dispatched into the real MCP tools by lib/browser-ui.ts).
 *
 * Built to dist/browser.html and served by lib/browser-ui.ts.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CreateForm } from "werkmeister-ui/create-form";
import { renderMarkdown } from "werkmeister-ui/lib/markdown";
import { appRoot, Css } from "werkmeister-ui/theme";
import { type HostBridge, WorkspaceList } from "werkmeister-ui/workspace-ui";
import { HealthTab } from "./health-ui.js";
import { PrsTab } from "./prs-ui.js";
import { LinksTab } from "./werkmeister-links-ui.js";

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

type Tab = "list" | "new" | "prs" | "health" | "links";

const TABS: [Tab, string][] = [
  ["list", "Workspaces"],
  ["new", "New workspace"],
  ["prs", "Open Pull Requests"],
  ["health", "Health"],
  ["links", "Links"],
];

const TAB_TITLES: Record<Tab, string> = {
  list: "Werkmeister Workspaces",
  new: "New workspace · Werkmeister Workspaces",
  prs: "Open Pull Requests · Werkmeister Workspaces",
  health: "Health · Werkmeister Workspaces",
  links: "Links · Werkmeister Workspaces",
};

function tabFromHash(): Tab {
  const h = location.hash.replace(/^#/, "");
  return h === "new" || h === "prs" || h === "health" || h === "links" ? h : "list";
}

// Each top-level tab is a page addressed by the URL hash (…/#list, …/#new), so
// tabs are deep-linkable and the browser Back/Forward buttons move between them.
// A click only changes the hash; the hashchange listener is the single place that
// switches tabs, so a click, a deep link and a Back-button pop take the same path.
function navigate(tab: Tab): void {
  if (tabFromHash() !== tab) location.hash = tab;
}

function Dashboard() {
  const [tab, setTab] = useState(tabFromHash);
  // A pane mounts on its first visit and then stays mounted (hidden), keeping its state.
  const visited = useRef(new Set<Tab>());
  visited.current.add(tab);
  // The Workspaces top bar lives in the shell header so it persists on every tab.
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const reloadList = useRef(() => {});

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.title = TAB_TITLES[tab];
  }, [tab]);

  const pane = (t: Tab, content: ReactNode) => (
    <div className="wsd-pane wsd-container" hidden={tab !== t}>
      {visited.current.has(t) && content}
    </div>
  );
  return (
    <>
      <Css id="wsd-shell" css={SHELL_CSS} />
      <div className="wsd-header wsd-container wsui" ref={setHeader} />
      <div className="wsd-tabs">
        <div className="wsd-tabrow wsd-container">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              className={t === tab ? "wsd-tab active" : "wsd-tab"}
              onClick={() => navigate(t)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="wsd-pane wsd-container wsui" hidden={tab !== "list"}>
        {header && (
          <WorkspaceList
            bridge={bridge}
            headerRoot={header}
            renderMarkdown={renderMarkdown}
            reloadRef={reloadList}
            onNewWorkspace={() => navigate("new")}
          />
        )}
      </div>
      {pane(
        "new",
        <CreateForm
          bridge={bridge}
          onCreated={() => {
            reloadList.current();
            navigate("list");
          }}
        />,
      )}
      {pane("prs", <PrsTab bridge={bridge} />)}
      {pane("health", <HealthTab bridge={bridge} active={tab === "health"} />)}
      {pane("links", <LinksTab />)}
    </>
  );
}

createRoot(appRoot()).render(<Dashboard />);
