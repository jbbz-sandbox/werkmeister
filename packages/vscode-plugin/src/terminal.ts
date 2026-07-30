/**
 * The one place the extension runs a `sandbox` command.
 *
 * A real terminal rather than an OutputChannel: ANSI colour, scrollback and
 * Ctrl-C come free, `sandbox workspace`'s interactive wizard needs a TTY, and
 * `cwd` makes the CLI resolve FEATURE/slot from that workspace's .env exactly as
 * a human running the command there would.
 *
 * The binary is the absolute path from resolveSandboxBin() — never a bare
 * `sandbox`, which would depend on the integrated terminal's PATH.
 */
import * as vscode from "vscode";
import { resolveSandboxBin } from "sandbox-driver";

/** POSIX single-quote escaping — the integrated terminal is a shell, not execFile. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const terminals: vscode.Terminal[] = [];

export function disposeTerminals(): void {
  for (const t of terminals.splice(0)) t.dispose();
}

/**
 * Run `sandbox <args…>` with `cwd` set to the workspace directory and show the
 * terminal. Resolves once the command has been sent — not when it finishes;
 * the tree's poll picks up the result.
 *
 * ponytail: a new terminal per invocation, not a reused one. `sandbox logs`
 * runs `docker compose logs -f`, which never exits, and `sandbox up` runs for
 * 30-60s — reusing a terminal whose foreground process is still alive means
 * the next command's text gets typed into that process's STDIN and silently
 * swallowed. VS Code 1.90 has no "did the foreground process finish" signal
 * to guard against that, so this leaves one terminal per command for the user
 * to close. Upgrade to a busy-flag once onDidEndTerminalShellExecution
 * (1.93+) is available.
 */
export async function runInTerminal(args: string[], cwd: string, label?: string): Promise<void> {
  let bin: string;
  try {
    bin = await resolveSandboxBin();
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return;
  }
  const term = vscode.window.createTerminal({ name: `sandbox ${label ?? args[0]}`, cwd });
  terminals.push(term);
  term.sendText([shellQuote(bin), ...args.map(shellQuote)].join(" "), true);
  term.show(true);
}
