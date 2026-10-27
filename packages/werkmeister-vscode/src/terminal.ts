/**
 * The one place the extension runs a `werkmeister` command.
 *
 * A real terminal rather than an OutputChannel: ANSI colour, scrollback and
 * Ctrl-C come free, `werkmeister workspace`'s interactive wizard needs a TTY, and
 * `cwd` makes the CLI resolve FEATURE/slot from that workspace's .env exactly as
 * a human running the command there would.
 *
 * The binary is the absolute path from resolveSandboxBin() — never a bare
 * `werkmeister`, which would depend on the integrated terminal's PATH.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveSandboxBin } from "werkmeister-core";
import { claim, forget, release, type Slot } from "./terminal-pool.js";

/** POSIX single-quote escaping — the integrated terminal is a shell, not execFile. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const terminals: Slot<vscode.Terminal>[] = [];

/**
 * Shell integration is what makes reuse safe: the execution events fire only in
 * terminals where it activated. Where it never does, no end event arrives, the
 * slot stays busy, and each command gets its own terminal exactly as before.
 */
const listeners = [
  vscode.window.onDidEndTerminalShellExecution((e) => release(terminals, e.terminal)),
  vscode.window.onDidCloseTerminal((t) => forget(terminals, t)),
];

export function disposeTerminals(): void {
  for (const d of listeners.splice(0)) d.dispose();
  for (const s of terminals.splice(0)) s.term.dispose();
}

/** VS Code's own documented window for shell integration to activate in a new terminal. */
const SHELL_INTEGRATION_MS = 3_000;

/**
 * Wait for a new terminal's shell integration, since it activates a beat after
 * creation and the execution events only start firing then. Sending sooner
 * loses that command's end event and would strand the slot as busy forever.
 * Resolves immediately for a terminal that already has it, and gives up rather
 * than blocking a shell that will never report.
 */
function whenReady(term: vscode.Terminal): Promise<void> {
  if (term.shellIntegration) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    };
    const timer = setTimeout(finish, SHELL_INTEGRATION_MS);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) finish();
    });
  });
}

/**
 * Run `werkmeister <args…>` with `cwd` set to the workspace directory and show the
 * terminal. Resolves once the command has been sent — not when it finishes;
 * the tree's poll picks up the result.
 *
 * Reuses a terminal only once its foreground command has ended: `werkmeister logs`
 * runs `docker compose logs -f` and never exits, and `werkmeister up` runs for
 * 30-60s — text sent while that process is alive is swallowed by its STDIN
 * instead of running. Reuse is keyed on cwd because the CLI resolves
 * FEATURE/slot from the .env there, so the name is derived from cwd too: a
 * reused terminal keeps the name it was created with, and naming it after the
 * first command would leave `werkmeister stop foo` running every later up/down.
 * `name` is for the callers whose cwd says nothing useful (the wizard, `connect`).
 */
export async function runInTerminal(args: string[], cwd: string, name?: string): Promise<void> {
  let bin: string;
  try {
    bin = await resolveSandboxBin();
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return;
  }
  const term = claim(terminals, cwd, () =>
    vscode.window.createTerminal({ name: `werkmeister ${name ?? path.basename(cwd)}`, cwd }),
  );
  await whenReady(term);
  term.sendText([shellQuote(bin), ...args.map(shellQuote)].join(" "), true);
  term.show(true);
}
