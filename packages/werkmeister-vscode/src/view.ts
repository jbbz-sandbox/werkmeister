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
  type WorkspaceStatus,
} from "werkmeister-core";
import { callTool, DaemonUnavailable } from "werkmeister-core/daemon_client";
import type { WorkspaceResources } from "werkmeister-core/resources";
import type { InterceptsSnapshot } from "werkmeister-core/status";
import type { PrInput } from "werkmeister-ui";
import {
  buildTree,
  cliNotFoundNode,
  daemonDownNode,
  LEGEND_NODE,
  type WsNode,
} from "./build-tree.js";
import { CARD_COMMANDS, CARD_CSS, findNode, renderCards } from "./cards.js";
import { pollWhileVisible } from "./poll.js";

const POLL_MS = 5000;
/** The stats sweep costs the daemon about a second per run, so CPU/memory refresh on a slower clock (SW-41). */
const RESOURCE_POLL_MS = 30000;

/** Theme variables only, so the cards follow whatever theme is active, live. */
const CSS = `
body{padding:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
.top,.card{padding:10px 12px}
/* Mixed from the text colour: a theme's own panel border is often too faint to part the cards. */
.card{border-top:1px solid color-mix(in srgb,var(--vscode-foreground) 30%,transparent);display:flex;flex-direction:column;gap:3px}
.row{display:flex;flex-wrap:wrap;gap:2px 12px;align-items:baseline}
.name{font-weight:600}
.card,.name,blockquote{overflow-wrap:anywhere}
.dim{color:var(--vscode-descriptionForeground)}
.pre{white-space:pre-wrap}
.svc{white-space:nowrap}
blockquote{margin:0;padding:0;border:0;background:none;font-style:italic}
a{color:var(--vscode-textLink-foreground);text-decoration:none}
a:hover{color:var(--vscode-textLink-activeForeground);text-decoration:underline}
button{margin-top:2px;padding:3px 10px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;cursor:pointer}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
a:focus-visible,button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
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
  private prsRequested = false;
  private legend = false;
  /** Undefined until the first sweep lands; null when it failed. */
  private resources: WorkspaceResources | null | undefined;
  private sweeping = false;

  toggleLegend(): void {
    this.legend = !this.legend;
    this.post();
  }

  refresh(): void {
    void this.load();
  }

  /**
   * One `gh pr list` per repo worktree, so this runs on first load and on
   * ↻ Refresh PRs only, never on the 5s poll.
   */
  async refreshPrs(): Promise<void> {
    this.prsRequested = true;
    try {
      this.prs = new Map((await getWorkspacePRs()).map((w) => [w.name, w.repos]));
    } catch {
      this.prs = null;
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
    view.onDidDispose(() => {
      for (const stop of stops) stop();
      messages.dispose();
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
    void this.view?.webview.postMessage({ html: renderCards(nodes) });
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
      this.roots = buildTree(
        workspaces.workspaces,
        statuses.statuses,
        intercepts,
        currentFolderPaths(),
        {
          prs: this.prs,
          // Files only, so cheap enough for every poll.
          lifecycles: new Map(
            workspaces.workspaces.map((w) => [w.name, lifecycleOf(w.path).state]),
          ),
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

/** Every folder open in this window — a multi-root workspace has more than one. */
function currentFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
