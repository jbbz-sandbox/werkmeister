/**
 * Container logs, in a terminal the extension owns rather than a shell.
 *
 * A `Pseudoterminal` instead of `runInTerminal`, because `werkmeister logs` is the
 * one command that never exits: sent into a shell terminal it strands that
 * terminal busy forever (terminal-pool's deliberate degrade), and nothing holds
 * the tail, so closing the tab orphans it. Here the extension owns the tail —
 * closing the tab stops it.
 *
 * The Output panel was the other candidate and cannot work: VS Code renders a
 * raw `ESC` as a control-character box, so the per-service prefix colour
 * would arrive as literal `[36m` noise on every line.
 *
 * The tail itself runs in the host daemon and arrives over its SSE endpoint (SW-184).
 */
import * as vscode from "vscode";
import type { LogTail } from "werkmeister-core/compose";
import { streamLogs } from "werkmeister-core/daemon_client";

interface Tail {
  terminal: vscode.Terminal;
  /** False once the tail has ended — a terminal still showing a finished tail. */
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
 * Tail `workspace`'s containers, optionally narrowed to one `service`, in a
 * dedicated terminal. Re-invoking while the tail is alive reveals it instead of
 * starting a second one; once the tail has ended the terminal is replaced, so
 * the command always leaves a live tail on screen.
 */
export function showLogs(workspace: string, service: string | null): void {
  const key = `${workspace} ${service ?? ""}`;
  const existing = tails.get(key);
  if (existing?.alive()) {
    existing.terminal.show();
    return;
  }
  existing?.terminal.dispose();

  const write = new vscode.EventEmitter<string>();
  let tail: LogTail | null = null;
  let ended = false;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    open: () => {
      // xterm needs CRLF; a bare LF only drops a row, staircasing every line.
      const emit = (chunk: string) => write.fire(chunk.replace(/\r?\n/g, "\r\n"));
      tail = streamLogs(workspace, service, emit);
      void tail.done.then(
        () => {
          ended = true;
          emit("\n[logs stopped]\n");
        },
        (e: Error) => {
          ended = true;
          emit(`\n[logs failed: ${e.message}]\n`);
        },
      );
    },
    // Fired when the tab is closed, so the tail never outlives what shows it.
    close: () => tail?.stop(),
    handleInput: (data) => {
      if (data === CTRL_C) tail?.stop();
    },
  };

  const terminal = vscode.window.createTerminal({
    name: `logs ${service ?? workspace}`,
    iconPath: new vscode.ThemeIcon("output"),
    // A session restored on reload has no tail behind it — only a
    // dead terminal that looks live.
    isTransient: true,
    pty,
  });
  tails.set(key, {
    terminal,
    alive: () => tail !== null && !ended,
  });
  terminal.show();
}
