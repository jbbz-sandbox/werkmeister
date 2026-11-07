/**
 * The one place the extension runs a `werkmeister` command.
 *
 * A real terminal rather than an OutputChannel: ANSI colour, scrollback and
 * Ctrl-C come free, `werkmeister workspace new`'s interactive wizard needs a TTY, and
 * `cwd` makes the CLI resolve FEATURE/slot from that workspace's .env exactly as
 * a human running the command there would.
 *
 * The binary is the absolute path from resolveSandboxBin() — never a bare
 * `werkmeister`, which would depend on the integrated terminal's PATH.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveSandboxBin } from "werkmeister-core";
import { dotDir } from "werkmeister-core/dot_dir";
import { shellQuote } from "./harness/claude/uri.js";
import { claim, forget, release, type Slot, takeGone } from "./terminal-pool.js";

const terminals: Slot<vscode.Terminal>[] = [];

/** Claude/codex sessions: busy for good, so `claim` never hands one out; tracked only to close them (SW-421). */
const sessionTerminals: Slot<vscode.Terminal>[] = [];

/**
 * One file per session terminal, named by its shell's pid and holding its cwd. Close-out's
 * `openTerminalSessions` skips the claude under it, and close-out deletes the file once it is done:
 * the cue to close the terminal, since close-out often runs inside it (SW-421).
 * shortcut: a VS Code crash leaves stale files, and a reused pid could hide one `/exit it` line; sweep dead pids on activate if that is ever seen.
 */
const PID_DIR = path.join(dotDir(os.homedir()), "vscode-terminals");
const pidFiles = new Map<vscode.Terminal, string>();

/** A missing file only means close-out lists the session as before, so errors are dropped. */
export function trackSessionTerminal(term: vscode.Terminal, cwd: string): void {
  sessionTerminals.push({ term, cwd, busy: true });
  void term.processId.then((pid) => {
    // Closed before its pid arrived: the close listener has already run.
    if (!pid || !sessionTerminals.some((s) => s.term === term)) return;
    const file = path.join(PID_DIR, String(pid));
    try {
      fs.mkdirSync(PID_DIR, { recursive: true });
      fs.writeFileSync(file, cwd);
      pidFiles.set(term, file);
    } catch {}
  });
}

function dropPidFile(term: vscode.Terminal): void {
  const file = pidFiles.get(term);
  if (!file) return;
  pidFiles.delete(term);
  fs.rmSync(file, { force: true });
}

/** How soon a closed-out workspace's terminals go; existsSync on a handful of paths is free. */
const GONE_CHECK_MS = 3_000;

function closeGoneTerminals(): void {
  for (const t of takeGone(terminals, (s) => fs.existsSync(s.cwd))) t.dispose();
  // A session waits for close-out to drop its pid file too, so a moved folder doesn't kill it.
  const sessions = takeGone(sessionTerminals, (s) => {
    const file = pidFiles.get(s.term);
    return fs.existsSync(s.cwd) || (file !== undefined && fs.existsSync(file));
  });
  if (!sessions.length) return;
  for (const t of sessions) t.dispose();
  void vscode.window.showInformationMessage(
    `werkmeister: closed ${sessions.map((t) => t.name).join(", ")} — workspace closed out`,
  );
}

/**
 * Shell integration is what makes reuse safe: the execution events fire only in
 * terminals where it activated. Where it never does, no end event arrives, the
 * slot stays busy, and each command gets its own terminal exactly as before.
 */
const listeners = [
  vscode.window.onDidEndTerminalShellExecution((e) => release(terminals, e.terminal)),
  vscode.window.onDidCloseTerminal((t) => {
    forget(terminals, t);
    forget(sessionTerminals, t);
    dropPidFile(t);
  }),
];
const goneCheck = setInterval(closeGoneTerminals, GONE_CHECK_MS);

export function disposeTerminals(): void {
  clearInterval(goneCheck);
  for (const d of listeners.splice(0)) d.dispose();
  for (const s of [...terminals.splice(0), ...sessionTerminals.splice(0)]) s.term.dispose();
  // The close listener is gone by now, so the files go here.
  for (const t of [...pidFiles.keys()]) dropPidFile(t);
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
 * Reuses a terminal only once its foreground command has ended: `werkmeister feature logs`
 * runs `docker compose logs -f` and never exits, and `werkmeister feature up` runs for
 * 30-60s — text sent while that process is alive is swallowed by its STDIN
 * instead of running. Reuse is keyed on cwd because the CLI resolves
 * FEATURE/slot from the .env there, so the name is derived from cwd too: a
 * reused terminal keeps the name it was created with, and naming it after the
 * first command would leave `werkmeister feature stop foo` running every later up/down.
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
