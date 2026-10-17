/**
 * VS Code plumbing for the Workspaces view: fetch the three sandbox-core payloads,
 * hand them to the pure builder, and map WsNode → TreeItem. No display logic
 * lives here — that is all in build-tree.ts.
 */

import { getIntercepts, getWorkspaceStatuses, listWorkspaces } from "sandbox-core";
import * as vscode from "vscode";
import { buildTree, cliNotFoundNode, type WsNode } from "./build-tree.js";
import { pollWhileVisible } from "./poll.js";

const POLL_MS = 5000;

export class SandboxTreeProvider implements vscode.TreeDataProvider<WsNode> {
  private readonly changed = new vscode.EventEmitter<WsNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private roots: WsNode[] = [];
  private loading = false;

  refresh(): void {
    void this.load();
  }

  /**
   * Poll only while the view is visible. A hidden view costs nothing, and a
   * fetch-once-on-open design freezes the indicator dots.
   * The scheduling itself lives in poll.ts so it can be unit-tested.
   */
  bind(view: vscode.TreeView<WsNode>): vscode.Disposable {
    return new vscode.Disposable(pollWhileVisible(view, () => this.refresh(), POLL_MS));
  }

  private async load(): Promise<void> {
    // ponytail: skip an overlapping poll rather than queueing. A slow docker ps
    // just means one fewer refresh, never a backlog.
    if (this.loading) return;
    this.loading = true;
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
      );
    } catch (e) {
      this.roots = [cliNotFoundNode((e as Error).message)];
    } finally {
      this.loading = false;
      this.changed.fire(undefined);
    }
  }

  getChildren(node?: WsNode): WsNode[] {
    return node ? node.children : this.roots;
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
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    item.iconPath = new vscode.ThemeIcon(
      node.icon.id,
      node.icon.color ? new vscode.ThemeColor(node.icon.color) : undefined,
    );
    if (node.command) {
      item.command = { command: node.command, title: node.label };
    }
    return item;
  }
}

/** Every folder open in this window — a multi-root workspace has more than one. */
function currentFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
