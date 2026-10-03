import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { listWorkspaces, resolveSandboxBin, childEnv, removeWorkspace } from "sandbox-core";
import { getReposRoot } from "sandbox-core/config";
import { runInTerminal } from "./terminal.js";
import { showLogs } from "./logs.js";
import type { SandboxTreeProvider } from "./tree.js";
import type { WsNode } from "./build-tree.js";

/**
 * The workspace a command should act on: the tree node it was invoked from, or —
 * when invoked from the palette with no node — whichever the user picks.
 */
async function pickWorkspace(node?: WsNode): Promise<{ name: string; path: string } | null> {
  if (node?.workspace) return { name: node.workspace.name, path: node.workspace.path };
  let listed: Awaited<ReturnType<typeof listWorkspaces>>;
  try {
    listed = await listWorkspaces();
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return null;
  }
  if (!listed.workspaces.length) {
    void vscode.window.showInformationMessage(`No workspaces found under ${listed.root}.`);
    return null;
  }
  const choice = await vscode.window.showQuickPick(
    listed.workspaces.map((w) => ({
      label: w.name,
      description: w.jiraId ?? "",
      detail: w.path,
      ws: w,
    })),
    { placeHolder: "Select a sandbox workspace" },
  );
  return choice ? { name: choice.ws.name, path: choice.ws.path } : null;
}

/** Lifecycle actions that map 1:1 onto a `sandbox <action>` subcommand. */
const LIFECYCLE = ["up", "stop", "restart", "down"] as const;

/** Jira key or browse URL, loosely validated — the CLI does the real check. */
const JIRA_REF_RE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;

/** Lazily created so it doesn't clutter the Output dropdown until something fails. */
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel("Sandbox Workspaces");
  return outputChannel;
}

export function disposeOutputChannel(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}

/** Open a workspace's folder in a new window. */
async function openWorkspace(node?: WsNode): Promise<void> {
  const ws = await pickWorkspace(node);
  if (!ws) return;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(ws.path), {
    forceNewWindow: true,
  });
}

/**
 * Make a workspace this window's *first* folder, adding it if it isn't open yet
 * and moving it up if it is. First place is load-bearing, not cosmetic: the
 * Claude Code extension reads CLAUDE.md from folder 0, so switching without
 * reordering leaves it reading the wrong workspace's instructions.
 */
async function switchWorkspace(node?: WsNode): Promise<void> {
  const ws = await pickWorkspace(node);
  if (!ws) return;
  const uri = vscode.Uri.file(ws.path);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders[0]?.uri.fsPath === uri.fsPath) return;

  // One splice over the whole list: updateWorkspaceFolders may only be called
  // once per event loop turn, so add-and-reorder has to be a single call.
  // A name survives only if passed back, so custom-labelled folders of a
  // multi-root `.code-workspace` would be renamed by every switch.
  const rest = folders
    .filter((f) => f.uri.fsPath !== uri.fsPath)
    .map((f) => (f.name === basename(f.uri.fsPath) ? { uri: f.uri } : { uri: f.uri, name: f.name }));
  const ok = vscode.workspace.updateWorkspaceFolders(0, folders.length, { uri }, ...rest);
  if (!ok) void vscode.window.showErrorMessage(`Could not open ${ws.name} in this window.`);
}

/** A git checkout under `paths.repos_root` — the set `sandbox registry sync` reads fragments from. */
async function pickRepo(): Promise<string | null> {
  const root = getReposRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((n) => fs.existsSync(join(root, n, ".git"))).sort();
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return null;
  }
  if (!names.length) {
    void vscode.window.showInformationMessage(`No git repos found under ${root}.`);
    return null;
  }
  const choice = await vscode.window.showQuickPick(
    names.map((n) => ({
      label: n,
      description: fs.existsSync(join(root, n, ".sandbox", "services.yaml")) ? "has services.yaml" : "",
      path: join(root, n),
    })),
    { placeHolder: "Select a repo to detect services in" },
  );
  return choice?.path ?? null;
}

export function registerCommands(provider: SandboxTreeProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("sandbox.refresh", () => provider.refresh()),

    // Deliberately not sandbox-core's openWorkspace(), which shells out to the
    // `code` CLI — from inside VS Code the native command is direct and can't
    // fail on a missing `code` binary.
    vscode.commands.registerCommand("sandbox.open", openWorkspace),
    vscode.commands.registerCommand("sandbox.switch", switchWorkspace),

    vscode.commands.registerCommand("sandbox.openJira", async (node?: WsNode) => {
      const url = node?.workspace?.jiraUrl;
      if (!url) {
        void vscode.window.showInformationMessage("This workspace has no Jira ticket.");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand("sandbox.configure", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "sandbox.");
    }),

    ...LIFECYCLE.map((action) =>
      vscode.commands.registerCommand(`sandbox.${action}`, async (node?: WsNode) => {
        const ws = await pickWorkspace(node);
        if (!ws) return;
        await runInTerminal([action], ws.path);
      }),
    ),

    vscode.commands.registerCommand("sandbox.toggleIntercept", async (node?: WsNode) => {
      const svc = node?.service;
      if (!svc) return;
      const args = ["intercept", "-s", svc.name];
      if (svc.leave) args.push("--leave");
      await runInTerminal(args, svc.workspacePath);
    }),

    // Menu-only (see commandPalette below): the feature is only known from a
    // tree node — there is nothing for a bare palette invocation to pass.
    //
    // Unlike its siblings this does not shell out to `sandbox logs`. That
    // command ends in `proc.run` (spawnSync, `stdio: "inherit"`), so nothing
    // here could read its output, and killing it would leave its `docker
    // compose` grandchild tailing. See logs.ts.
    vscode.commands.registerCommand("sandbox.logs", (node?: WsNode) => {
      if (!node) return;
      // A service node scopes the logs to itself; a workspace node tails them all.
      if (node.service?.feature) {
        showLogs(node.service.feature, node.service.name);
        return;
      }
      if (node.workspace?.feature) {
        showLogs(node.workspace.feature, null);
        return;
      }
      const name = node.workspace?.name ?? node.service?.name ?? "this workspace";
      void vscode.window.showWarningMessage(
        `Could not determine the feature name for '${name}' — is it initialised?`,
      );
    }),

    // The CLI's own interactive wizard does the prompting; a VS Code terminal is
    // a TTY, so there is nothing to reimplement. Only the optional Jira ref is
    // collected up front, because it changes the workspace directory name.
    vscode.commands.registerCommand("sandbox.newWorkspace", async () => {
      const ref = await vscode.window.showInputBox({
        title: "New Sandbox Workspace",
        prompt: "Jira ticket (optional) — press Enter to skip",
        placeHolder: "TRE-1234",
        validateInput: (v) =>
          !v.trim() || JIRA_REF_RE.test(v.trim()) ? null : "Expected a key like TRE-1234, or empty",
      });
      if (ref === undefined) return; // Escape — cancelled
      const args = ["workspace"];
      if (ref.trim()) args.push("--jira-id", ref.trim().toUpperCase());
      await runInTerminal(args, os.homedir(), "workspace");
    }),

    // `sandbox open` blocks for the whole lifetime of the Chrome window (Ctrl-C
    // is how you close it), so it gets its own detached process rather than
    // occupying the shared terminal.
    // ponytail: fire-and-forget — a launch failure after spawn is invisible.
    // Add a status check if that ever matters.
    vscode.commands.registerCommand("sandbox.openFeature", async (node?: WsNode) => {
      const ws = await pickWorkspace(node);
      if (!ws) return;
      let bin: string;
      try {
        bin = await resolveSandboxBin();
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
        return;
      }
      const child = spawn(bin, ["open"], {
        cwd: ws.path,
        detached: true,
        stdio: "ignore",
        env: childEnv(),
      });
      child.on("error", (e) => void vscode.window.showErrorMessage(`sandbox open: ${e.message}`));
      child.unref();
      void vscode.window.showInformationMessage(`Opening a tagged browser for '${ws.name}'…`);
    }),

    // The CLI prompts for the Claude assist and before writing, so like
    // newWorkspace it runs in a terminal rather than being reimplemented here.
    vscode.commands.registerCommand("sandbox.detect", async () => {
      const repo = await pickRepo();
      if (repo) await runInTerminal(["detect", repo], repo);
    }),

    vscode.commands.registerCommand("sandbox.registrySync", async () => {
      await runInTerminal(["registry", "sync"], getReposRoot(), "registry");
    }),

    vscode.commands.registerCommand("sandbox.remove", async (node?: WsNode) => {
      const ws = await pickWorkspace(node);
      if (!ws) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove workspace '${ws.name}'?`,
        {
          modal: true,
          detail: `Commits and pushes every branch first — the delete is aborted if any push fails. Then tears down containers, deletes ${ws.path}, and prunes the worktrees.`,
        },
        "Remove",
      );
      if (confirm !== "Remove") return;
      try {
        // Not cancellable: this commits/pushes every worktree branch then tears
        // down containers and deletes the directory — interrupting a partial
        // teardown is worse than waiting out the (up to minutes-long) call.
        const { path: removed } = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Removing workspace '${ws.name}'…`,
            cancellable: false,
          },
          () => removeWorkspace(ws.name),
        );
        void vscode.window.showInformationMessage(`Removed ${removed}`);
        provider.refresh();
      } catch (e) {
        // sandbox-core's failure message is a multi-line handoff report (which
        // branch failed to push, etc.) — a toast squeezes it onto one line, so
        // the full text goes to the output channel and the toast just points there.
        const channel = getOutputChannel();
        channel.appendLine((e as Error).message);
        channel.show();
        void vscode.window.showErrorMessage(
          `Failed to remove workspace '${ws.name}' — see the "Sandbox Workspaces" output channel for details.`,
        );
      }
    }),
  ];
}
