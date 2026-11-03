/** Claude Code in a VS Code terminal (SW-187): the Continue and New Session commands. */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { listWorkspaces, reconcileLaunch } from "werkmeister-core";
import { parseLaunchUri } from "./uri.js";

export const CONTINUE_COMMAND = "claude --continue";
export const NEW_SESSION_COMMAND = "claude";

/**
 * A Claude session never exits, so it gets its own terminal rather than a
 * pooled `werkmeister` one it would hold busy forever.
 */
export function openClaudeTerminal(ws: { name: string; path: string }, command: string): void {
  const term = vscode.window.createTerminal({ name: `claude ${ws.name}`, cwd: ws.path });
  term.sendText(command, true);
  term.show();
}

/** `vscode://jbbz.werkmeister-vscode/…` from werkmeister-core's claude-resume / pr-reconcile (SW-195). */
export function registerClaudeUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      try {
        const launch = parseLaunchUri(uri.path, uri.query);
        if (launch.kind === "reconcile") {
          const { dir, command } = reconcileLaunch(launch.slug);
          // Core wrote the context file there before opening the URI; a bare slug has nothing to run.
          if (!fs.existsSync(dir)) throw new Error(`No reconcile session at ${dir}`);
          const term = vscode.window.createTerminal({
            name: `claude reconcile ${launch.slug}`,
            cwd: dir,
          });
          term.sendText(command, true);
          term.show(true); // background, like the Terminal.app launch
          return;
        }
        const ws = (await listWorkspaces()).workspaces.find((w) => w.name === launch.workspace);
        if (!ws) throw new Error(`No workspace named ${JSON.stringify(launch.workspace)}`);
        openClaudeTerminal({ name: ws.name, path: ws.path }, launch.command);
      } catch (e) {
        void vscode.window.showErrorMessage(`werkmeister: ${(e as Error).message}`);
      }
    },
  });
}
