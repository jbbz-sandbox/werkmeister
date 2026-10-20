/**
 * VS Code plumbing for the Workspaces view: fetch the three werkmeister-core payloads,
 * hand them to the pure builder, and map WsNode → TreeItem. No display logic
 * lives here — that is all in build-tree.ts.
 */

import * as vscode from "vscode";
import {
  getIntercepts,
  getWorkspacePRs,
  getWorkspaceResources,
  getWorkspaceStatuses,
  lifecycleOf,
  listWorkspaces,
  type WorkspaceResources,
} from "werkmeister-core";
import type { PrInput } from "werkmeister-ui";
import {
  buildTree,
  cliNotFoundNode,
  LEGEND_NODE,
  TOOLTIP_COMMANDS,
  type WsNode,
} from "./build-tree.js";
import { pollWhileVisible } from "./poll.js";

const POLL_MS = 5000;
/** The stats sweep costs the daemon about a second per run, so CPU/memory refresh on a slower clock (SW-41). */
const RESOURCE_POLL_MS = 30000;

export class SandboxTreeProvider implements vscode.TreeDataProvider<WsNode> {
  private readonly changed = new vscode.EventEmitter<WsNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

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
    this.changed.fire(undefined);
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
  bind(view: vscode.TreeView<WsNode>): vscode.Disposable {
    const stops = [
      pollWhileVisible(view, () => this.refresh(), POLL_MS),
      pollWhileVisible(view, () => void this.sweep(), RESOURCE_POLL_MS),
    ];
    return new vscode.Disposable(() => {
      for (const stop of stops) stop();
    });
  }

  /** Kept apart from load(): a slow sweep must never hold up the rows. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      this.resources = await getWorkspaceResources();
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
        getWorkspaceStatuses(),
        getIntercepts(),
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
      this.roots = [cliNotFoundNode((e as Error).message)];
    } finally {
      this.loading = false;
      this.changed.fire(undefined);
    }
  }

  getChildren(node?: WsNode): WsNode[] {
    if (node) return node.children;
    return this.legend ? [LEGEND_NODE, ...this.roots] : this.roots;
  }

  getTreeItem(node: WsNode): vscode.TreeItem {
    const collapsible =
      node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;

    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.id;
    item.description = node.description;
    if (node.kind === "workspace") {
      const md = new vscode.MarkdownString(node.tooltip);
      md.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
      item.tooltip = md;
    } else {
      item.tooltip = node.tooltip;
    }
    item.contextValue = node.contextValue;
    item.iconPath = new vscode.ThemeIcon(
      node.icon.id,
      node.icon.color ? new vscode.ThemeColor(node.icon.color) : undefined,
    );
    if (node.command) {
      item.command = { command: node.command, title: node.label, arguments: [node] };
    }
    return item;
  }
}

/** Every folder open in this window — a multi-root workspace has more than one. */
function currentFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
