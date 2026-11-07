/** A workspace session in a VS Code terminal (SW-187; Codex too since SW-384): Continue, New Session and the URI handler. */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { CODEX_LAUNCH, listWorkspaces, reconcileLaunch } from "werkmeister-core";
import { harnessIdOf } from "werkmeister-core/harness_layout";
import { trackSessionTerminal } from "../../terminal.js";
import { parseLaunchUri, type SessionMode, sessionCommand } from "./uri.js";

/**
 * A Claude session never exits, so it gets its own terminal rather than a
 * pooled `werkmeister` one it would hold busy forever.
 */
export function openClaudeTerminal(
  ws: { name: string; path: string },
  command: string,
  harness = "claude",
): void {
  const term = vscode.window.createTerminal({ name: `${harness} ${ws.name}`, cwd: ws.path });
  trackSessionTerminal(term, ws.path);
  term.sendText(command, true);
  term.show();
}

/** `vscode://jbbz.werkmeister-vscode/…` from werkmeister-core's claude-resume / pr-reconcile (SW-195). */
export function registerClaudeUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      try {
        const name = new URLSearchParams(uri.query).get("workspace");
        const ws = name
          ? (await listWorkspaces()).workspaces.find((w) => w.name === name)
          : undefined;
        const harness = ws ? harnessIdOf(ws.path) : "claude";
        const launch = parseLaunchUri(uri.path, uri.query, harness, CODEX_LAUNCH, ws?.name);
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
        if (!ws) throw new Error(`No workspace named ${JSON.stringify(launch.workspace)}`);
        openClaudeTerminal({ name: ws.name, path: ws.path }, launch.command, harness);
      } catch (e) {
        void vscode.window.showErrorMessage(`werkmeister: ${(e as Error).message}`);
      }
    },
  });
}

/** Continue / New Session in the workspace's own harness (SW-384). */
export function openSessionTerminal(
  ws: { name: string; path: string },
  mode: Exclude<SessionMode, "resume">,
): void {
  const harness = harnessIdOf(ws.path);
  openClaudeTerminal(ws, sessionCommand(harness, mode, "", CODEX_LAUNCH), harness);
}
