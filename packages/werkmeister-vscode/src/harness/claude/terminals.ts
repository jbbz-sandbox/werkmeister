/** A workspace session in a VS Code terminal (SW-187; Codex too since SW-384): Continue, New Session and the URI handler. */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { CODEX_LAUNCH, listWorkspaces, reconcileLaunch, startArgs } from "werkmeister-core";
import { harnessIdOf } from "werkmeister-core/harness_layout";
import { trackSessionTerminal } from "../../terminal.js";
import {
  liveSessionTerminal,
  parseLaunchUri,
  type SessionMode,
  sessionCommand,
  sessionTabName,
  shellQuote,
} from "./uri.js";

/**
 * A Claude session never exits, so it gets its own terminal rather than a
 * pooled `werkmeister` one it would hold busy forever.
 */
export function openClaudeTerminal(
  ws: { name: string; path: string },
  command: string,
  harness = "claude",
): void {
  const term = vscode.window.createTerminal({
    name: sessionTabName(ws.name),
    cwd: ws.path,
    // Codex keeps a different icon so the two harnesses tell apart at a glance.
    iconPath: new vscode.ThemeIcon(harness === "claude" ? "terminal" : "terminal-bash"),
  });
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

/** Continue and the card's Open terminal: the workspace's live session terminal if this window has one, else Continue in a new one. */
export function focusSessionTerminal(ws: { name: string; path: string }): void {
  const open = liveSessionTerminal(vscode.window.terminals, ws.name, harnessIdOf(ws.path));
  if (open) open.show();
  else openSessionTerminal(ws, "continue");
}

/**
 * The card's ▶ Start work: a new session given the run's starting prompt, the one the pane's
 * ▶ Start work and `werkmeister workspace prompt --args` build (SW-153), on the workspace's model.
 */
export async function startWorkTerminal(ws: { name: string; path: string }): Promise<void> {
  const harness = harnessIdOf(ws.path);
  const a = await startArgs(ws.path);
  const command = [
    sessionCommand(harness, "new", "", CODEX_LAUNCH),
    // Codex takes its model from its own config.
    a.model && harness === "claude" ? `--model ${shellQuote(a.model)}` : "",
    shellQuote(`${a.prompt}\n\n${a.background}`),
  ]
    .filter(Boolean)
    .join(" ");
  openClaudeTerminal(ws, command, harness);
}

const MASTER_CONTROL = "Master control";

/**
 * The chat at the workspaces root, where triage and next-wave run: focus it, else start one there.
 * A chat started by hand has no name of ours, so after the name it is any terminal whose shell sits
 * at the root, bar the `werkmeister …` command terminals that run there (the New Workspace wizard).
 * shortcut: a plain shell left at the root is focused too; the cwd needs shell integration.
 */
export function focusMasterControl(root: string): void {
  const all = vscode.window.terminals;
  const open =
    all.find((t) => t.name.includes(MASTER_CONTROL)) ??
    all.find((t) => t.shellIntegration?.cwd?.fsPath === root && !t.name.startsWith("werkmeister "));
  if (open) {
    open.show();
    return;
  }
  const term = vscode.window.createTerminal({
    name: MASTER_CONTROL,
    cwd: root,
    iconPath: new vscode.ThemeIcon("circuit-board"),
  });
  term.sendText(sessionCommand("claude", "continue"), true);
  term.show();
}

/** Continue / New Session in the workspace's own harness (SW-384). */
export function openSessionTerminal(
  ws: { name: string; path: string },
  mode: Exclude<SessionMode, "resume">,
): void {
  const harness = harnessIdOf(ws.path);
  openClaudeTerminal(ws, sessionCommand(harness, mode, "", CODEX_LAUNCH), harness);
}
