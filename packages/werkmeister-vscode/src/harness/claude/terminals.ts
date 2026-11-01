/** Claude Code in a VS Code terminal (SW-187): the Continue and New Session commands. */
import * as vscode from "vscode";

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
