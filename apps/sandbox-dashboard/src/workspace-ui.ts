/**
 * Shared Sandbox Workspaces UI — the single source for all three surfaces:
 *
 *   • Browser dashboard     (src/browser-main.ts   → dist/browser.html)
 *   • Cowork live artifact  (src/artifact-main.ts  → dist/workspace-list.artifact.html)
 *   • MCP App inline view   (src/mcp-list.ts       → dist/mcp-list.html)
 *
 * The UI is host-agnostic: every server call and external link goes through
 * the {@link HostBridge} the entrypoint supplies. Features: expandable
 * workspace cards (container state, issue status, repos + PRs), lifecycle
 * actions, and an embedded Claude Code chat panel that continues the
 * workspace's newest session (fire-and-forget sends; the browser surface
 * live-streams via SSE — the other two poll `claude-transcript` /
 * `claude-turn-status`).
 *
 * Deliberately DEPENDENCY-FREE of npm packages and uses no
 * React/JSX. It's the shared UI for all three surfaces, and one of them is
 * the Cowork artifact (dist/workspace-list.artifact.html, ~33KB, strict CSP);
 * importing React here would drag it into that bundle. The RJSF *form*
 * (create-form.ts / mcp-app.ts / localhost-form.ts) uses React ONLY because RJSF
 * requires it and those surfaces already pay for it — do NOT add React to this
 * file. The shared `el(tag, class?, text?)` DOM helper (src/theme.ts) is the
 * vanilla-land counterpart to those files' `e = React.createElement`:
 * different names on purpose — the name tells you which paradigm (and which
 * bundle) you're in. Every import this file has (theme, chat-panel,
 * usage-widget, lib/workspace-search) is itself npm-dependency-free, so it's
 * safe in the strict-CSP bundle too.
 */
import { filterWorkspaces } from "../lib/workspace-search.js";
import { type ClaudeMessage, initChatPanel } from "./chat-panel.js";
import { el, injectCss } from "./theme.js";
import { renderUsage, type WorkspaceUsage } from "./usage-widget.js";

export interface HostBridge {
  /**
   * Call a Sandbox server tool by its short name (e.g. "list-workspaces") and
   * resolve its structured content. Must throw on tool errors and when the
   * host connection isn't available.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
  /** Open an external URL (issue, PR) in the user's browser. */
  openLink(url: string): void;
  /**
   * Optional live session stream. Present ONLY on the browser surface (a
   * same-origin Express server that can hold an SSE socket); when absent,
   * buildChat falls back to claude-transcript/claude-turn-status polling. This
   * optional method IS the fallback switch — the Desktop-inline and Cowork
   * artifact surfaces leave it undefined and keep polling.
   *
   * Delivers backfill (`onEntry` per index, then `onReady`) followed by live
   * `onEntry`/`onTurn` deltas. Entries are index-addressed upserts. Returns an
   * unsubscribe.
   */
  streamSession?(
    name: string,
    handlers: {
      onEntry(index: number, message: ClaudeMessage): void;
      onTurn(state: "running" | "done" | "failed", error?: string | null): void;
      onReady(meta?: {
        sessionId: string | null;
        sessionCount: number;
        updatedAt: string | null;
      }): void;
    },
    /** Resume backfill from this entry index (skips what a reconnect already has). */
    fromIndex?: number,
    /** Pin the stream to a specific session id; absent → follow the newest. */
    sessionId?: string,
  ): () => void;
}

const CSS = `
  :root { color-scheme: light; }
  .wsui, .wsui * { box-sizing: border-box; }
  .wsui {
    font-family: var(--sd-sans);
    background: var(--sd-bg); color: var(--sd-ink); padding: 20px;
  }
  .wsui header { margin-bottom: 12px; }
  .wsui h1 { margin: 0 0 4px; font-size: 20px; }
  .wsui .sub { color: var(--sd-muted); font-size: 13px; }
  .wsui .controls { display: flex; gap: 12px; align-items: center; margin: 14px 0; }
  .wsui input[type="search"] {
    flex: 1; padding: 8px 12px; border: 1px solid var(--sd-ctl-border);
    border-radius: 8px; font-size: 14px; background: var(--sd-card);
  }
  .wsui .count { font-size: 13px; color: var(--sd-muted); white-space: nowrap; }

  .wsui .ws { background: var(--sd-card); border: 1px solid var(--sd-line); border-left: 3px solid var(--sd-line); border-radius: 10px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); overflow: hidden; }
  .wsui .ws.rail-up { border-left-color: var(--sd-ok-dot); }
  .wsui .ws.rail-stopped { border-left-color: var(--sd-warn-dot); }
  .wsui .ws.rail-partial { border-left-color: #dd6b20; }
  .wsui .ws.rail-down { border-left-color: var(--sd-ghost); }
  .wsui .ws-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; user-select: none; }
  .wsui .ws-head:hover { background: var(--sd-soft); }
  .wsui .caret { color: var(--sd-ghost); font-size: 12px; transition: transform 0.15s; width: 10px; }
  .wsui .ws.open .caret { transform: rotate(90deg); }
  .wsui .ws-name { font-weight: 600; font-size: 14px; flex: 1; }
  .wsui .ws-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .wsui .repo-count { font-size: 12px; color: var(--sd-faint); }

  .wsui .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .wsui .b-issue { background: var(--sd-info-bg); color: var(--sd-info); cursor: pointer; }
  .wsui .b-issue:hover { text-decoration: underline; }
  .wsui .status { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .wsui .st-dev { background: var(--sd-info-bg); color: var(--sd-info); }
  .wsui .st-todo { background: var(--sd-line-soft); color: var(--sd-muted); }
  .wsui .st-def { background: var(--sd-warn-bg); color: var(--sd-warn); }
  .wsui .st-closed { background: var(--sd-ok-bg); color: var(--sd-ok); }
  .wsui .st-other { background: var(--sd-line-soft); color: var(--sd-muted); }
  .wsui .st-loading { background: var(--sd-line-soft); color: var(--sd-ghost); font-weight: 500; }

  .wsui .cstate { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .wsui .dot { width: 7px; height: 7px; border-radius: 50%; }
  .wsui .c-up { background: var(--sd-ok-bg); color: var(--sd-ok); } .wsui .c-up .dot { background: var(--sd-ok-dot); }
  .wsui .c-stopped { background: var(--sd-warn-bg); color: var(--sd-warn); } .wsui .c-stopped .dot { background: var(--sd-warn-dot); }
  .wsui .c-partial { background: #fdf0e6; color: #c05621; } .wsui .c-partial .dot { background: #dd6b20; }
  .wsui .c-down { background: var(--sd-line-soft); color: var(--sd-faint); } .wsui .c-down .dot { background: var(--sd-ghost); }

  .wsui .waiting { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--sd-warn-bg); color: var(--sd-warn); white-space: nowrap; }
  .wsui .waiting .dot { background: var(--sd-warn-dot); animation: wsui-pulse 1.4s ease-in-out infinite; }
  @keyframes wsui-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  .wsui .panel { display: none; border-top: 1px solid var(--sd-line-soft); }
  .wsui .ws.open .panel { display: block; }

  .wsui .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px; background: var(--sd-soft); border-bottom: 1px solid var(--sd-line-soft); align-items: center; }
  .wsui .btn { font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--sd-ctl-border); background: var(--sd-card); color: var(--sd-ink); cursor: pointer; }
  .wsui .btn:hover { background: var(--sd-hover); }
  .wsui .btn:disabled { opacity: 0.5; cursor: default; }
  .wsui .btn.primary { background: var(--sd-accent); border-color: var(--sd-accent); color: #fff; }
  .wsui .btn.primary:hover { background: var(--sd-accent-hover); }
  .wsui .btn.go { border-color: var(--sd-ok-border); color: var(--sd-ok); }
  .wsui .btn.danger { border-color: var(--sd-err-border); color: var(--sd-err); }
  .wsui .btn.danger:hover { background: var(--sd-err-bg); }
  .wsui .act-msg { font-size: 12px; color: var(--sd-muted); margin-left: auto; }
  .wsui .act-msg.err { color: var(--sd-err); }
  .wsui .act-msg.ok { color: var(--sd-ok); }

  .wsui .usage-panel { padding: 8px 14px; font-size: 12px; border-bottom: 1px solid var(--sd-line-soft); }

  .wsui .repos { padding: 6px 0; }
  .wsui .repo { display: flex; align-items: center; gap: 10px; padding: 8px 14px 8px 34px; font-size: 13px; border-bottom: 1px solid var(--sd-line-soft); }
  .wsui .repo:last-child { border-bottom: none; }
  .wsui .repo-name { font-weight: 600; min-width: 130px; }
  .wsui .branch { font-family: var(--sd-mono); font-size: 11px; color: var(--sd-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wsui .pr { display: flex; align-items: center; gap: 6px; }
  .wsui .pr-state { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.03em; }
  .wsui .pr-open { background: var(--sd-ok-bg); color: var(--sd-ok); }
  .wsui .pr-merged { background: #f0e9ff; color: #7642d6; }
  .wsui .pr-closed { background: var(--sd-err-bg); color: var(--sd-err); }
  .wsui .lbl { font-size: 10px; background: var(--sd-warn-bg); color: var(--sd-warn); padding: 1px 6px; border-radius: 4px; }
  .wsui .link { color: var(--sd-info); cursor: pointer; }
  .wsui .link:hover { text-decoration: underline; }
  .wsui .none { color: var(--sd-ghost); }
  .wsui .load-status { padding: 24px; text-align: center; color: var(--sd-muted); font-size: 14px; }
  .wsui .err { color: var(--sd-err); }
  .wsui .prloading { font-size: 11px; color: var(--sd-ghost); padding: 8px 14px 8px 34px; }

  /* --- Top status bar: infra + connect + k8s forwards + kube context --- */
  .wsui .topbar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    margin: 10px 0 0; padding: 8px 12px;
    background: var(--sd-card); border: 1px solid var(--sd-line); border-radius: 10px;
    font-size: 12px; color: var(--sd-muted);
  }
  .wsui .tb-item { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .wsui .tb-item .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sd-ghost); }
  .wsui .dot.ok { background: var(--sd-ok-dot); }
  .wsui .dot.warn { background: var(--sd-warn-dot); }
  .wsui .dot.bad { background: var(--sd-err); }
  .wsui .dot.unknown { background: var(--sd-ghost); }
  .wsui .tb-btn { font-size: 11px; padding: 3px 9px; }
  .wsui .tb-msg { font-size: 11px; color: var(--sd-faint); }
  .wsui .tb-msg.err { color: var(--sd-err); }
  .wsui .tb-k8s { cursor: pointer; }
  .wsui .tb-k8s:hover { text-decoration: underline; }
  .wsui .tb-sep { color: var(--sd-ctl-border); }
  .wsui .kube-ctx {
    font-family: var(--sd-mono); font-size: 10px;
    color: var(--sd-faint); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* .kube-env pills come from the theme; the chat panel styles itself
     (src/chat-panel.ts, .claude-chat scope); .usage-* rows come from
     src/usage-widget.ts. */
`;

interface WorkspaceEntry {
  name: string;
  path: string;
  vscodeUri: string;
  issueId: string | null;
  issueUrl: string | null;
  labels: string[];
}

export function initWorkspaceUI(
  bridge: HostBridge,
  root: HTMLElement,
  opts?: { headerRoot?: HTMLElement; renderMarkdown?: (src: string) => string },
): { reload: () => void } {
  // ---- skeleton ----
  injectCss("wsui", CSS);

  // The header (title + topbar) can live in a shell element supplied by the
  // caller (the browser dashboard lifts it above its tabs so it persists on
  // both tabs). When no headerRoot is given (Cowork artifact, MCP inline view)
  // it renders in-pane as before. `$` resolves IDs in the pane first, then the
  // header host — data-ids are unique across the two.
  const headerHost = opts?.headerRoot ?? root;
  const headerHTML = `
    <header>
      <h1>Sandbox Dashboard</h1>
      <div class="sub" data-id="root-path"></div>
      <div class="topbar" data-id="topbar" style="display:none;"></div>
    </header>`;
  const bodyHTML = `
    <div class="controls" data-id="controls" style="display:none;">
      <input type="search" data-id="filter" placeholder="Filter by name, issue ID, status, repo, labels…">
      <span class="count" data-id="count"></span>
    </div>
    <div class="load-status" data-id="status">Loading workspaces…</div>
    <div data-id="list"></div>`;

  root.classList.add("wsui");
  if (headerHost === root) {
    root.innerHTML = headerHTML + bodyHTML;
  } else {
    headerHost.classList.add("wsui");
    headerHost.innerHTML = headerHTML;
    root.innerHTML = bodyHTML;
  }
  const $ = (id: string) =>
    (root.querySelector(`[data-id="${id}"]`) ??
      headerHost.querySelector(`[data-id="${id}"]`)) as HTMLElement;

  // ---- state ----
  let all: WorkspaceEntry[] = [];
  let statuses: Record<string, string> = {}; // issueId -> status name
  let statusesLoading = false;
  let cstateLoaded = false; // false until the first workspace-status resolves
  const prsByWs: Record<string, any[]> = {};
  let cstateByWs: Record<string, any> = {};
  const openState: Record<string, boolean> = {};
  const chatState: Record<string, any> = {};
  const chatCtl: Record<
    string,
    { onExpand?: () => void; onVisibility?: (visible: boolean) => void }
  > = {};
  const panelCache: Record<string, HTMLElement> = {};
  // Usage panels are cached per workspace too (same reason as panelCache): a
  // rebuilt "Usage" button must keep toggling the SAME node, not a fresh one,
  // so re-renders (chat activity ticks, action clicks) don't orphan it open.
  const usagePanelCache: Record<string, HTMLElement> = {};
  function getUsagePanel(name: string): HTMLElement {
    let p = usagePanelCache[name];
    if (!p) {
      p = el("div", "usage-panel");
      p.style.display = "none";
      usagePanelCache[name] = p;
    }
    return p;
  }

  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);

  // Tab hidden/shown → drop/restore each open panel's live stream (streaming
  // surface only; polling panels have no onVisibility and are unaffected). A
  // panel is "visible" only when its card is expanded AND the tab is showing.
  document.addEventListener("visibilitychange", () => {
    for (const name in chatCtl) chatCtl[name].onVisibility?.(!!openState[name] && !document.hidden);
  });

  function statusClass(s: string | null): string {
    if (!s) return "st-other";
    const l = s.toLowerCase();
    if (l.includes("development") || l.includes("progress")) return "st-dev";
    if (l.includes("to do") || l.includes("todo") || l.includes("backlog")) return "st-todo";
    if (l.includes("definition")) return "st-def";
    if (l.includes("closed") || l.includes("done")) return "st-closed";
    return "st-other";
  }
  function prStateClass(s: string | null): string {
    if (s === "OPEN") return "pr-open";
    if (s === "MERGED") return "pr-merged";
    if (s === "CLOSED") return "pr-closed";
    return "";
  }
  function linkEl(cls: string, label: string, url: string, title?: string): HTMLElement {
    const e = el("span", `link ${cls}`.trim(), label);
    if (title) e.title = title;
    e.addEventListener("click", (ev) => {
      ev.stopPropagation();
      bridge.openLink(url);
    });
    return e;
  }

  let infraState: any = null;
  let updateInfraUI: () => void = () => {};

  async function refreshStatus(): Promise<void> {
    try {
      const d = await call("workspace-status", {});
      cstateByWs = {};
      (d.statuses || []).forEach((s: any) => (cstateByWs[s.name] = s));
      cstateLoaded = true;
      infraState = d.infra || null;
      updateInfraUI();
    } catch (e) {
      /* keep stale */
    }
  }

  // ---- top status bar: infra + connect, k8s forwards health, kube context ----
  function dotClassFor(healthy: number, total: number): string {
    if (!total) return "unknown";
    if (healthy === total) return "ok";
    if (healthy === 0) return "bad";
    return "warn";
  }

  function initTopBar(): void {
    const bar = $("topbar");
    bar.style.display = "flex";
    bar.innerHTML = "";

    // Shared infra: dot + label + Connect button (disabled while up & healthy).
    const infraItem = el("span", "tb-item");
    const infraDot = el("span", "dot unknown");
    const infraLabel = el("span", null, "Infra …");
    infraItem.appendChild(infraDot);
    infraItem.appendChild(infraLabel);
    bar.appendChild(infraItem);

    const connect = el("button", "btn tb-btn", "Connect infra") as HTMLButtonElement;
    connect.disabled = true;
    const msg = el("span", "tb-msg", "");
    bar.appendChild(connect);

    updateInfraUI = () => {
      if (!infraState) return;
      const s = infraState.state as string;
      infraDot.className =
        "dot " + (s === "up" ? "ok" : s === "partial" ? "warn" : s === "down" ? "bad" : "unknown");
      infraLabel.textContent = infraState.total
        ? `Infra ${s} ${infraState.running}/${infraState.total}`
        : `Infra ${s}`;
      const healthy = s === "up";
      connect.disabled = healthy;
      connect.title = healthy
        ? "Shared infrastructure is up and healthy — nothing to connect."
        : "Start shared infrastructure (sandbox connect)";
    };

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      msg.className = "tb-msg";
      msg.textContent = "Running sandbox connect…";
      try {
        await call("sandbox-connect", {});
        msg.textContent = "Infrastructure connected.";
        await refreshStatus();
        applyFilter();
        void refreshK8s();
      } catch (e) {
        msg.className = "tb-msg err";
        msg.textContent = "Connect failed — see server logs.";
        updateInfraUI(); // re-enable per actual state
      }
    });

    // k8s forwards health chip — click to re-check.
    bar.appendChild(el("span", "tb-sep", "|"));
    const k8sItem = el("span", "tb-item tb-k8s");
    const k8sDot = el("span", "dot unknown");
    const k8sLabel = el("span", null, "k8s forwards …");
    k8sItem.appendChild(k8sDot);
    k8sItem.appendChild(k8sLabel);
    k8sItem.title = "Default k8s port-forwards — click to re-check";
    bar.appendChild(k8sItem);

    let k8sChecking = false;
    async function refreshK8s(): Promise<void> {
      if (k8sChecking) return;
      k8sChecking = true;
      k8sLabel.textContent = "k8s forwards …";
      k8sDot.className = "dot unknown";
      try {
        const d = await call("k8s-forwards-status", {});
        k8sDot.className = "dot " + dotClassFor(d.healthy, d.total);
        k8sLabel.textContent = `k8s forwards ${d.healthy}/${d.total}`;
        const bad = (d.forwards || []).filter((f: any) => !f.healthy);
        k8sItem.title = bad.length
          ? "Unhealthy: " +
            bad.map((f: any) => `${f.name} :${f.port} (${f.detail})`).join(", ") +
            " — click to re-check"
          : "All default k8s port-forwards healthy — click to re-check";
      } catch (e) {
        k8sDot.className = "dot unknown";
        k8sLabel.textContent = "k8s forwards ?";
        k8sItem.title = "Couldn’t check k8s forwards — click to retry";
      }
      k8sChecking = false;
    }
    k8sItem.addEventListener("click", () => void refreshK8s());

    // Kube context: env pill + context name + "Switch to dev" when off-dev.
    bar.appendChild(el("span", "tb-sep", "|"));
    const kubeWrap = el("span", "tb-item");
    kubeWrap.appendChild(el("span", null, "Kube:"));
    const kubePill = el("span", "kube-env other", "…");
    const kubeCtx = el("span", "kube-ctx", "");
    const kubeSwitch = el("button", "btn tb-btn", "Switch to dev") as HTMLButtonElement;
    kubeSwitch.style.display = "none";
    kubeSwitch.title = "Set kubectl context to the dev cluster";
    kubeWrap.appendChild(kubePill);
    kubeWrap.appendChild(kubeCtx);
    kubeWrap.appendChild(kubeSwitch);
    bar.appendChild(kubeWrap);
    bar.appendChild(msg); // shared message slot at the end

    // Force-refresh the issue status cache. Other data reloads too; only the
    // issue statuses skip their cache.
    bar.appendChild(el("span", "tb-sep", "|"));
    const issueRefresh = el("button", "btn tb-btn tb-k8s", "↻ Refresh issues") as HTMLButtonElement;
    issueRefresh.title = "Re-fetch issue statuses from the issue tracker, bypassing the cache";
    issueRefresh.addEventListener("click", () => {
      issueRefresh.disabled = true;
      void load({ refreshIssues: true }).finally(() => (issueRefresh.disabled = false));
    });
    bar.appendChild(issueRefresh);

    function paintKube(env: string, context: string | null): void {
      const known = ["dev", "stage", "prod"].includes(env) ? env : "other";
      kubePill.className = "kube-env " + known;
      kubePill.textContent = known === "other" ? "unknown" : env;
      kubeCtx.textContent = context || "";
      kubeCtx.title = context || "";
      kubeSwitch.style.display = env === "dev" ? "none" : "";
    }

    async function refreshKube(): Promise<void> {
      try {
        const k = await call("kube-context", {});
        paintKube(k.env ?? "other", k.context ?? null);
      } catch (e) {
        /* leave as-is */
      }
    }

    kubeSwitch.addEventListener("click", async () => {
      kubeSwitch.disabled = true;
      msg.className = "tb-msg";
      msg.textContent = "Switching kube context…";
      try {
        const k = await call("kube-switch", { env: "dev" });
        paintKube(k.env ?? "dev", k.context ?? null);
        msg.textContent = "Switched to dev.";
      } catch (e) {
        msg.className = "tb-msg err";
        msg.textContent = "Kube switch failed.";
      }
      kubeSwitch.disabled = false;
    });

    void refreshK8s();
    void refreshKube();
  }

  // Issue statuses in chunks of 5 so no call approaches the MCP timeout;
  // progressive render as chunks land, one retry per chunk.
  async function loadIssueStatuses(refs: string[], refresh = false): Promise<void> {
    const CHUNK = 5;
    statusesLoading = true;
    const chunks: string[][] = [];
    for (let i = 0; i < refs.length; i += CHUNK) chunks.push(refs.slice(i, i + CHUNK));
    for (const chunk of chunks) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const d = await call("issue-statuses", { refs: chunk, refresh });
          Object.assign(statuses, d.statuses || {});
          applyFilter();
          break;
        } catch (e) {
          if (attempt === 2)
            console.warn("issue-statuses chunk failed after retry:", chunk.join(","));
        }
      }
    }
    statusesLoading = false;
    applyFilter();
  }

  // ---- actions ----
  async function runAction(
    tool: string,
    args: Record<string, unknown>,
    msgEl: HTMLElement,
    btn: HTMLElement,
    verb: string,
  ): Promise<void> {
    const siblings = btn.parentElement!.querySelectorAll<HTMLButtonElement>(".btn");
    siblings.forEach((b) => (b.disabled = true));
    msgEl.className = "act-msg";
    msgEl.textContent = verb + "…";
    try {
      await call(tool, args);
      msgEl.className = "act-msg ok";
      msgEl.textContent = verb + " ✓";
      // close-out changes the SET of workspaces, not just a state — drop
      // it from `all` so its card disappears (refreshStatus only updates state).
      if (tool === "close-out") all = all.filter((w) => w.name !== args.name);
      await refreshStatus();
      applyFilter();
    } catch (e) {
      msgEl.className = "act-msg err";
      msgEl.textContent = verb + " failed";
      siblings.forEach((b) => (b.disabled = false));
    }
  }

  function buildActions(w: WorkspaceEntry): HTMLElement {
    const wrap = el("div", "actions");
    const cs = cstateByWs[w.name];
    const state = cs ? cs.state : "down";
    const msg = el("span", "act-msg");

    function addBtn(
      label: string,
      cls: string | null,
      tool: string,
      args: Record<string, unknown>,
      verb: string,
      confirmFirst?: boolean,
    ): void {
      const b = el("button", "btn" + (cls ? " " + cls : ""), label) as HTMLButtonElement;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (confirmFirst && b.dataset.armed !== "1") {
          b.dataset.armed = "1";
          b.textContent = "Click again to confirm";
          setTimeout(() => {
            if (b.isConnected) {
              b.dataset.armed = "0";
              b.textContent = label;
            }
          }, 4000);
          return;
        }
        void runAction(tool, args, msg, b, verb);
      });
      wrap.appendChild(b);
    }

    addBtn("Open in VS Code", "primary", "open-workspace", { name: w.name }, "Opening");
    if (state === "up" || state === "partial") {
      addBtn("Open feature ↗", "go", "open-feature", { name: w.name }, "Opening");
    }
    if (state === "down") {
      addBtn("Start", "go", "workspace-action", { name: w.name, action: "up" }, "Starting");
    } else {
      addBtn(
        "Restart",
        null,
        "workspace-action",
        { name: w.name, action: "restart" },
        "Restarting",
      );
      if (state !== "stopped")
        addBtn("Stop", null, "workspace-action", { name: w.name, action: "stop" }, "Stopping");
      else addBtn("Start", "go", "workspace-action", { name: w.name, action: "up" }, "Starting");
      addBtn("Down", null, "workspace-action", { name: w.name, action: "down" }, "Tearing down");
    }
    // Shipped only: abandoning needs a reason, which the pane, the CLI and the MCP tool take.
    addBtn("Close out", "danger", "close-out", { name: w.name }, "Closing out", true);

    // Usage: on-demand token/model breakdown, toggled open below the actions.
    // The panel itself is cached per workspace (see usagePanelCache) — this
    // button (rebuilt on every re-render) always binds to that same node, so
    // toggling and rendered content survive fill()'s "already filled" path.
    const usagePanel = getUsagePanel(w.name);
    const usageBtn = el("button", "btn", "Usage") as HTMLButtonElement;
    usageBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (usagePanel.style.display !== "none") {
        usagePanel.style.display = "none";
        return;
      }
      usagePanel.style.display = "";
      usagePanel.textContent = "Computing usage…";
      try {
        const u = (await call("workspace-usage", { name: w.name })) as WorkspaceUsage;
        renderUsage(usagePanel, u);
      } catch {
        usagePanel.textContent = "Failed to load usage.";
      }
    });
    wrap.appendChild(usageBtn);
    wrap.appendChild(msg);
    return wrap;
  }

  function buildRepos(w: WorkspaceEntry): HTMLElement {
    const container = el("div", "repos");
    const list = prsByWs[w.name];
    if (!list) {
      container.appendChild(el("div", "prloading", "Loading repos…"));
      return container;
    }
    if (!list.length) {
      container.appendChild(el("div", "prloading", "No repos found."));
      return container;
    }
    for (const r of list) {
      const row = el("div", "repo");
      row.appendChild(el("span", "repo-name", r.repo));
      row.appendChild(el("span", "branch", r.branch || ""));
      const pr = el("span", "pr");
      if (r.url) {
        pr.appendChild(linkEl("", "#" + r.url.split("/").pop(), r.url, r.title || ""));
        if (r.state) pr.appendChild(el("span", "pr-state " + prStateClass(r.state), r.state));
        (r.labels || []).forEach((l: string) => pr.appendChild(el("span", "lbl", l)));
      } else {
        pr.appendChild(el("span", "none", "no PR"));
      }
      row.appendChild(pr);
      container.appendChild(row);
    }
    return container;
  }

  // ---- Claude chat panel ----
  // The embedded Claude chat panel (src/chat-panel.ts) — shared verbatim with
  // the Open-Pull-Requests tab. We pass the list-badge hook so a workspace's
  // "waiting for input" pill stays live; the PR tab omits it.
  function buildChat(w: WorkspaceEntry): HTMLElement {
    const handle = initChatPanel(w.name, {
      bridge,
      placeholder: "Message this workspace\u2019s Claude session\u2026",
      renderMarkdown: opts?.renderMarkdown,
      onActivity: ({ waiting, running }) => {
        const cs = cstateByWs[w.name];
        if (!cs) return;
        cs.claude = { state: running ? "running" : (cs.claude?.state ?? "idle"), waiting };
        applyFilter(); // rebuild cards (cached panel + chat survive) so the badge updates
      },
    });
    chatCtl[w.name] = { onExpand: handle.onExpand, onVisibility: handle.onVisibility };
    return handle.el;
  }

  function cstatePill(w: WorkspaceEntry): HTMLElement | null {
    const cs = cstateByWs[w.name];
    const state = cs ? cs.state : null;
    if (!state) return null;
    const pill = el("span", "cstate c-" + state);
    pill.appendChild(el("span", "dot"));
    let label = state;
    if (cs.total) label += " " + cs.running + "/" + cs.total;
    pill.appendChild(el("span", null, label));
    return pill;
  }

  function render(list: WorkspaceEntry[]): void {
    const rootEl = $("list");
    rootEl.innerHTML = "";
    for (const w of list) {
      const ws = el("div", "ws");
      if (openState[w.name]) ws.classList.add("open");
      // Left status rail: colored by container state so the list reads as a
      // status board at a glance. Absent until workspace-status resolves.
      const railState = cstateByWs[w.name]?.state;
      if (railState) ws.classList.add("rail-" + railState);

      const head = el("div", "ws-head");
      head.appendChild(el("span", "caret", "▶"));
      head.appendChild(el("span", "ws-name", w.name));

      const meta = el("div", "ws-meta");
      const pill = cstatePill(w);
      if (pill) meta.appendChild(pill);
      // Cold-start skeleton: show a placeholder pill until the first
      // workspace-status resolves, so a fresh load never looks empty/broken.
      else if (!cstateLoaded) meta.appendChild(el("span", "status st-loading", "…"));
      if (cstateByWs[w.name]?.claude?.waiting) {
        const wb = el("span", "waiting");
        wb.appendChild(el("span", "dot"));
        wb.appendChild(el("span", null, "waiting for input"));
        wb.title = "Claude replied and is waiting for your next message";
        meta.appendChild(wb);
      }
      if (w.issueId && w.issueUrl)
        meta.appendChild(linkEl("badge b-issue", w.issueId, w.issueUrl, w.issueUrl));
      if (w.issueId) {
        const st = statuses[w.issueId];
        if (st) meta.appendChild(el("span", "status " + statusClass(st), st));
        else if (statusesLoading) meta.appendChild(el("span", "status st-loading", "…"));
      }
      const repos = prsByWs[w.name];
      if (repos) {
        const openPrs = repos.filter((r: any) => r.state === "OPEN").length;
        meta.appendChild(
          el(
            "span",
            "repo-count",
            repos.length +
              " repo" +
              (repos.length === 1 ? "" : "s") +
              (openPrs ? " · " + openPrs + " open PR" + (openPrs === 1 ? "" : "s") : ""),
          ),
        );
      }
      head.appendChild(meta);

      // Panels are cached per workspace so re-renders don't destroy the chat
      // panel or a half-typed message; actions/repos are rebuilt (live state).
      const panel = panelCache[w.name] || (panelCache[w.name] = el("div", "panel"));
      const fill = () => {
        if (panel.dataset.filled) {
          // buildActions() rebinds a fresh "Usage" button to the SAME cached
          // panel node (getUsagePanel), so the panel itself needs no action
          // here — it's already in the DOM at its prior open/closed state.
          const oldActions = panel.querySelector(".actions");
          if (oldActions) panel.replaceChild(buildActions(w), oldActions);
          const oldRepos = panel.querySelector(".repos");
          if (oldRepos) panel.replaceChild(buildRepos(w), oldRepos);
          return;
        }
        panel.appendChild(buildActions(w));
        panel.appendChild(getUsagePanel(w.name));
        panel.appendChild(buildRepos(w));
        panel.appendChild(buildChat(w));
        panel.dataset.filled = "1";
      };

      head.addEventListener("click", () => {
        const nowOpen = !ws.classList.contains("open");
        const wasFilled = !!panel.dataset.filled;
        openState[w.name] = nowOpen;
        ws.classList.toggle("open", nowOpen);
        if (nowOpen) {
          fill();
          if (wasFilled) chatCtl[w.name]?.onExpand?.();
          chatCtl[w.name]?.onVisibility?.(true);
        } else {
          chatCtl[w.name]?.onVisibility?.(false);
        }
      });

      ws.appendChild(head);
      ws.appendChild(panel);
      if (openState[w.name]) fill();
      rootEl.appendChild(ws);
    }
    $("count").textContent = list.length + " of " + all.length;
  }

  function applyFilter(): void {
    const raw = ($("filter") as HTMLInputElement).value.trim();
    render(raw ? filterWorkspaces(all, raw, { statuses, cstateByWs, prsByWs }) : all);
  }

  let autoRetries = 0;
  const MAX_AUTO_RETRIES = 3;

  async function load(opts?: { refreshIssues?: boolean }): Promise<void> {
    const s = $("status");
    s.className = "load-status";
    s.style.display = "block";
    s.textContent = autoRetries ? "Reconnecting to the host…" : "Loading workspaces…";
    try {
      const data = await call("list-workspaces", {});
      autoRetries = 0;
      all = data.workspaces || [];
      $("root-path").textContent = data.root || "";
      s.style.display = "none";
      $("controls").style.display = "flex";
      render(all);
      const filterInput = $("filter") as HTMLInputElement;
      if (!filterInput.dataset.bound) {
        filterInput.addEventListener("input", applyFilter);
        filterInput.dataset.bound = "1";
      }

      const refs = [...new Set(all.map((w) => w.issueId).filter(Boolean))] as string[];
      await Promise.all([
        refreshStatus(),
        refs.length ? loadIssueStatuses(refs, opts?.refreshIssues) : Promise.resolve(),
        call("workspace-prs", {})
          .then((d: any) =>
            (d.workspaces || []).forEach((w: any) => (prsByWs[w.name] = w.repos || [])),
          )
          .catch(() => {}),
      ]);
      applyFilter();
    } catch (e) {
      // The host bridge may still be wiring up on a cold open — auto-retry a
      // few times before surfacing a manual Retry button.
      if (autoRetries < MAX_AUTO_RETRIES) {
        autoRetries++;
        s.className = "load-status";
        s.textContent = `Connection not ready — retrying (${autoRetries}/${MAX_AUTO_RETRIES})…`;
        setTimeout(() => void load(), 3000);
        return;
      }
      s.className = "load-status err";
      s.innerHTML = "";
      s.appendChild(el("div", null, "Couldn’t reach the host: " + (e as Error).message));
      const hint = el(
        "div",
        null,
        "The connection may still be starting up. Wait a moment, then retry.",
      );
      hint.style.cssText = "font-size:12px;color:var(--sd-faint);margin:6px 0 10px;";
      s.appendChild(hint);
      const btn = el("button", "btn primary", "Retry");
      btn.addEventListener("click", () => {
        autoRetries = 0;
        void load();
      });
      s.appendChild(btn);
    }
  }

  initTopBar(); // independent of the workspace list — paints as data arrives
  void load();

  // Let the dashboard shell refresh the list after a workspace is created.
  return { reload: () => void load() };
}
