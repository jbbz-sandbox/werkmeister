/**
 * Container logs, in a terminal the extension owns rather than a shell.
 *
 * A `Pseudoterminal` instead of `runInTerminal`, because `sandbox logs` is the
 * one command that never exits: sent into a shell terminal it strands that
 * terminal busy forever (terminal-pool's deliberate degrade), and nothing holds
 * the `docker compose` pid, so closing the tab orphans the tail. Here the
 * extension spawns compose itself — closing the tab kills it.
 *
 * The Output panel was the other candidate and cannot work: VS Code renders a
 * raw `ESC` as a control-character box, so compose's per-service prefix colour
 * would arrive as literal `[36m` noise on every line.
 */
import type { ChildProcess } from "node:child_process";
import { childEnv } from "sandbox-core";
import { composeLogsStream } from "sandbox-core/compose";
import { COMPOSE_FILE } from "sandbox-core/compose_file";
import * as vscode from "vscode";

interface Tail {
  terminal: vscode.Terminal;
  /** False once compose has exited — a terminal still showing a finished tail. */
  alive: () => boolean;
}

const tails = new Map<string, Tail>();

const closed = vscode.window.onDidCloseTerminal((t) => {
  for (const [key, tail] of tails) {
    if (tail.terminal === t) tails.delete(key);
  }
});

export function disposeLogTerminals(): void {
  closed.dispose();
  for (const tail of tails.values()) tail.terminal.dispose();
  tails.clear();
}

/** ETX — a pty receives Ctrl-C as input rather than as a signal to the child. */
const CTRL_C = "\u0003";

/**
 * Tail `feature`'s containers, optionally narrowed to one `service`, in a
 * dedicated terminal. Re-invoking while the tail is alive reveals it instead of
 * starting a second one; once compose has exited the terminal is replaced, so
 * the command always leaves a live tail on screen.
 */
export function showLogs(feature: string, service: string | null): void {
  const key = `${feature} ${service ?? ""}`;
  const existing = tails.get(key);
  if (existing?.alive()) {
    existing.terminal.show();
    return;
  }
  existing?.terminal.dispose();

  const write = new vscode.EventEmitter<string>();
  let child: ChildProcess | null = null;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    open: () => {
      // xterm needs CRLF; a bare LF only drops a row, staircasing every line.
      const emit = (chunk: string) => write.fire(chunk.replace(/\r?\n/g, "\r\n"));
      child = composeLogsStream(feature, service, emit, childEnv());
      if (!child) {
        emit(`No ${COMPOSE_FILE} found for feature '${feature}'.\n`);
        return;
      }
      child.on("error", (e) => emit(`\ndocker compose: ${e.message}\n`));
      child.on("close", (code) => emit(`\n[compose logs exited with code ${code}]\n`));
    },
    // Fired when the tab is closed, so the tail never outlives what shows it.
    close: () => child?.kill(),
    handleInput: (data) => {
      if (data === CTRL_C) child?.kill();
    },
  };

  const terminal = vscode.window.createTerminal({
    name: `logs ${service ?? feature}`,
    iconPath: new vscode.ThemeIcon("output"),
    // A session restored on reload has no compose process behind it — only a
    // dead terminal that looks live.
    isTransient: true,
    pty,
  });
  tails.set(key, {
    terminal,
    alive: () => child !== null && child.exitCode === null && child.signalCode === null,
  });
  terminal.show();
}
