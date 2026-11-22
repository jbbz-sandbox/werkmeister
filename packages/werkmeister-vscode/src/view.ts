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
import type { PrInput } from "werkmeister-ui";
import {
  boardUrl,
  buildTree,
  cliNotFoundNode,
  daemonDownNode,
  inTerminal,
  LEGEND_NODE,
  prFilesKey,
  type WsNode,
} from "./build-tree.js";
import { CARD_COMMANDS, CARD_CSS, findNode, renderCards } from "./cards.js";
import { pollWhileVisible } from "./poll.js";

const POLL_MS = 5000;
/** The stats sweep costs the daemon about a second per run, so CPU/memory refresh on a slower clock (SW-41). */
const RESOURCE_POLL_MS = 30000;

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

export class WorkspacesView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private roots: WsNode[] = [];
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
      board: currentBoardUrl(),
    });
    void this.view?.webview.postMessage({ html });
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
        callTool<{ statuses: WorkspaceStatus[] }>("status").then((r) => r.data),
        callTool<InterceptsSnapshot>("intercepts").then((r) => interceptsFromSnapshot(r.data)),
      ]);
      // Files only, so cheap enough for every poll.
      const life = new Map(workspaces.workspaces.map((w) => [w.name, lifecycleOf(w.path)]));
      const prFiles = prFilesKey(new Map([...life].map(([name, l]) => [name, l.prs])));
      if (this.prFiles !== undefined && prFiles !== this.prFiles) void this.refreshPrs();
      this.prFiles = prFiles;
      this.roots = buildTree(
        workspaces.workspaces,
        statuses.statuses,
        intercepts,
        currentFolderPaths(),
        {
          prs: this.prs,
          prNeeds: this.prNeeds,
          lifecycles: new Map([...life].map(([name, l]) => [name, l.state])),
          usage: this.resources?.projects,
          host: this.resources === undefined ? undefined : (this.resources?.host ?? null),
        },
      );
    } catch (e) {
      this.roots = [
        e instanceof DaemonUnavailable
          ? daemonDownNode(e.message)
          : cliNotFoundNode((e as Error).message),
      ];
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
