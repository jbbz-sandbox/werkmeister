/**
 * VS Code plumbing for the Workspaces view: fetch the three payloads, hand them
 * to the pure builder, and post the cards to the webview. No display logic lives
 * here — build-tree.ts decides the words, cards.ts the markup. Docker and
 * telepresence reads go to the host daemon (SW-184); the workspace list and
 * lifecycle are file reads, kept local.
 *
 * A webview rather than a TreeView because a tree row is one line that cannot wrap.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  getWorkspacePRs,
  type InfraStatus,
  interceptsFromSnapshot,
  lifecycleOf,
  listWorkspaces,
  type NeedItem,
  type WorkspaceStatus,
} from "werkmeister-core";
import { workspacesRoot } from "werkmeister-core/config";
import { callTool, DaemonUnavailable } from "werkmeister-core/daemon_client";
import { loadJira } from "werkmeister-core/global_config";
import { loadProjects } from "werkmeister-core/projects";
import type { WorkspaceResources } from "werkmeister-core/resources";
import type { InterceptsSnapshot } from "werkmeister-core/status";
import type { PrInput, StatusStrip } from "werkmeister-ui";
import {
  boardUrl,
  buildTree,
  cliNotFoundNode,
  daemonDownNode,
  inTerminal,
  LEGEND_NODE,
  prFilesKey,
  stripOf,
  type WsNode,
} from "./build-tree.js";
import { CARD_COMMANDS, CARD_CSS, findNode, renderCards } from "./cards.js";
import { pollWhileVisible } from "./poll.js";

const POLL_MS = 5000;
/** The stats sweep costs the daemon about a second per run, so CPU/memory refresh on a slower clock (SW-41). */
const RESOURCE_POLL_MS = 30000;
/** `.w0{width:0%}` … `.w10{width:100%}`: the meter widths cards.ts names by class. */
const METER_WIDTHS = Array.from({ length: 11 }, (_, i) => `.w${i}{width:${i * 10}%}`).join("");

/** Theme variables only, so the cards follow whatever theme is active, live. */
const CSS = `
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

/** The page is a shell: the host posts the cards, a click posts back a command id and a node id. */
function shell(): string {
  const nonce = randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
addEventListener("message", (e) => { root.innerHTML = e.data.html; });
root.addEventListener("click", (e) => {
  const el = e.target.closest("[data-cmd]");
  if (!el) return;
  e.preventDefault();
  vscode.postMessage({ cmd: el.dataset.cmd, id: el.dataset.id });
});
vscode.postMessage({ cmd: "ready" });
</script>
</body>
</html>`;
}

/** The memento key and the `when` context key the two title-bar commands swap on. */
const HIDE_MERGED = "sandbox.mergedHidden";
/** The `when` context key that shows the Jira board icon only when there is a board. */
const HAS_BOARD = "sandbox.hasBoard";

export class WorkspacesView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private roots: WsNode[] = [];
  private strip: StatusStrip = { chips: [], host: null };
  private loading = false;
  /** Undefined until the first fetch lands; null when it failed (the card's "PRs unavailable"). */
  private prs: Map<string, PrInput[]> | null | undefined;
  private prNeeds = new Map<string, { prNeeds: NeedItem[]; phaseDetail: string | null }>();
  private prsRequested = false;
  /** The last poll's {@link prFilesKey}: a change refetches PRs (SW-818). */
  private prFiles: string | undefined;
  private legend = false;
  /** Undefined until the first sweep lands; null when it failed. */
  private resources: WorkspaceResources | null | undefined;
  private sweeping = false;
  /** SW-1003; kept in the extension, since the webview redraws every 5 s and would reset a control in it. */
  private hideMerged: boolean;

  constructor(private readonly memento: vscode.Memento) {
    this.hideMerged = memento.get(HIDE_MERGED, false);
    void vscode.commands.executeCommand("setContext", HIDE_MERGED, this.hideMerged);
  }

  setHideMerged(on: boolean): void {
    this.hideMerged = on;
    void this.memento.update(HIDE_MERGED, on);
    void vscode.commands.executeCommand("setContext", HIDE_MERGED, on);
    this.post();
  }

  toggleLegend(): void {
    this.legend = !this.legend;
    this.post();
  }

  refresh(): void {
    // A task ending or a setting changing before the view opens has nothing to redraw (SW-979).
    if (this.view) void this.load();
  }

  /**
   * One `gh pr list` per repo worktree, so this runs on first load, on ↻ Refresh PRs and when a
   * PR file changes (SW-818), never on every 5s poll.
   */
  async refreshPrs(): Promise<void> {
    this.prsRequested = true;
    try {
      const all = await getWorkspacePRs();
      this.prs = new Map(all.map((w) => [w.name, w.repos]));
      this.prNeeds = new Map(
        all.map((w) => [w.name, { prNeeds: w.needs, phaseDetail: w.phaseDetail }]),
      );
    } catch {
      this.prs = null;
      // No stale PR needs beside "PRs unavailable".
      this.prNeeds = new Map();
    }
    this.refresh();
  }

  /**
   * Poll only while the view is visible. A hidden view costs nothing, and a
   * fetch-once-on-open design freezes the indicator dots.
   * The scheduling itself lives in poll.ts so it can be unit-tested.
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = shell();
    // A WebviewView's visibility event carries no payload; poll.ts wants the flag.
    const visibility = {
      get visible() {
        return view.visible;
      },
      onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) =>
        view.onDidChangeVisibility(() => listener({ visible: view.visible })),
    };
    const stops = [
      pollWhileVisible(visibility, () => this.refresh(), POLL_MS),
      pollWhileVisible(visibility, () => void this.sweep(), RESOURCE_POLL_MS),
    ];
    const messages = view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    // The cue moves on a tab switch at once, from the cached cards: no fetch (SW-864).
    const terminal = vscode.window.onDidChangeActiveTerminal(() => this.post());
    view.onDidDispose(() => {
      for (const stop of stops) stop();
      messages.dispose();
      terminal.dispose();
      this.view = undefined;
    });
  }

  /** The page reloads whenever the view is shown again, and says so; the rest are clicks. */
  private onMessage(m: { cmd?: unknown; id?: unknown }): void {
    if (m.cmd === "ready") {
      this.post();
      return;
    }
    if (typeof m.cmd !== "string" || !CARD_COMMANDS.includes(m.cmd)) return;
    // The node comes from our own tree by id; nothing the page sends is passed on.
    const node = typeof m.id === "string" && m.id ? findNode(this.roots, m.id) : undefined;
    void vscode.commands.executeCommand(m.cmd, node);
  }

  private post(): void {
    const nodes = this.legend ? [LEGEND_NODE, ...this.roots] : this.roots;
    const workspaces = this.roots.flatMap((n) => (n.workspace ? [n.workspace] : []));
    const html = renderCards(nodes, {
      inTerminal: inTerminal(
        workspaces,
        terminalCwd(vscode.window.activeTerminal),
        workspacesRoot(),
      ),
      strip: this.strip,
      hideMerged: this.hideMerged,
    });
    void this.view?.webview.postMessage({ html });
    // The board icon's `when` clause; a config edit shows or hides it on the next post.
    void vscode.commands.executeCommand("setContext", HAS_BOARD, currentBoardUrl() !== null);
    const needs = this.strip.chips.find((c) => c.kind === "needs")?.count ?? 0;
    if (this.view)
      this.view.badge = needs ? { value: needs, tooltip: `${needs} need you` } : undefined;
  }

  /** Undefined until the first sweep lands, null when it failed: the strip's host line. */
  private host() {
    return this.resources === undefined ? undefined : (this.resources?.host ?? null);
  }

  /** Kept apart from load(): a slow sweep must never hold up the rows. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      this.resources = (await callTool<WorkspaceResources>("resources")).data;
    } catch {
      this.resources = null;
    } finally {
      this.sweeping = false;
    }
    this.refresh();
  }

  private async load(): Promise<void> {
    // ponytail: skip an overlapping poll rather than queueing. A slow docker ps
    // just means one fewer refresh, never a backlog.
    if (this.loading) return;
    this.loading = true;
    if (!this.prsRequested) void this.refreshPrs();
    try {
      // Independent reads — a failed intercept lookup must not cost the list.
      const [workspaces, statuses, intercepts] = await Promise.all([
        listWorkspaces(),
        callTool<{ statuses: WorkspaceStatus[]; infra: InfraStatus }>("status").then((r) => r.data),
        callTool<InterceptsSnapshot>("intercepts").then((r) => interceptsFromSnapshot(r.data)),
      ]);
      // Files only, so cheap enough for every poll.
      const life = new Map(workspaces.workspaces.map((w) => [w.name, lifecycleOf(w.path)]));
      const prFiles = prFilesKey(new Map([...life].map(([name, l]) => [name, l.prs])));
      if (this.prFiles !== undefined && prFiles !== this.prFiles) void this.refreshPrs();
      this.prFiles = prFiles;
      const extra = {
        prs: this.prs,
        prNeeds: this.prNeeds,
        lifecycles: new Map([...life].map(([name, l]) => [name, l.state])),
        usage: this.resources?.projects,
        host: this.host(),
        infra: statuses.infra,
      };
      this.roots = buildTree(
        workspaces.workspaces,
        statuses.statuses,
        intercepts,
        currentFolderPaths(),
        extra,
      );
      this.strip = stripOf(this.roots, statuses.statuses, extra);
    } catch (e) {
      this.roots = [
        e instanceof DaemonUnavailable
          ? daemonDownNode(e.message)
          : cliNotFoundNode((e as Error).message),
      ];
      this.strip = stripOf([], [], { host: this.host() });
    } finally {
      this.loading = false;
      this.post();
    }
  }
}

/**
 * Where a terminal started, else where its shell is now. A `werkmeister …` command terminal
 * (`feature logs`, `up`) also sits in a workspace folder but is not its session, so it has none.
 */
function terminalCwd(t: vscode.Terminal | undefined): string | undefined {
  if (!t || t.name.startsWith("werkmeister ")) return undefined;
  const cwd = (t.creationOptions as vscode.TerminalOptions).cwd ?? t.shellIntegration?.cwd;
  return typeof cwd === "string" ? cwd : cwd?.fsPath;
}

/** The default Jira project's board (`projects:` in ~/.werkmeister/config.yaml), or null. File reads only. */
export function currentBoardUrl(): string | null {
  try {
    return boardUrl(loadJira().base_url, loadProjects());
  } catch {
    return null;
  }
}

/** Every folder open in this window — a multi-root workspace has more than one. */
function currentFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
