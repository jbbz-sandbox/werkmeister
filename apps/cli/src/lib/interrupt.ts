/**
 * Who owns Ctrl-C.
 *
 * The CLI installs one default SIGINT handler for every command: print
 * `Interrupted`, exit 130. That is right for the commands that just stop —
 * but not for one that has cleanup to run first. `sandbox open` closes the
 * browser window and removes its throwaway Chrome profile when its poll loop
 * winds down, and the default handler is registered *first*, so it called
 * `process.exit(130)` before the command's own listener ever ran. The cleanup
 * had never executed: Ctrl-C left the browser running and the profile on disk.
 *
 * So the default stands aside when the signal is claimed. A command claims it
 * by adding its own `process.on("SIGINT", …)` listener, which is exactly what a
 * command needing cleanup already does.
 */

/**
 * A SIGINT listener beyond {@link installDefaultInterrupt}'s own means a
 * command is handling the interrupt itself.
 *
 * Counting listeners rather than tracking a registration is deliberate: it
 * cannot fall out of step with reality, and the alternative is a claim/release
 * protocol every future command would have to remember. It does assume nothing
 * *else* adds a process-level SIGINT listener — today nothing does (`wizard.ts`
 * listens on its readline interface, not on `process`).
 */
function claimed(proc: NodeJS.EventEmitter): boolean {
  return proc.listenerCount("SIGINT") > 1;
}

/**
 * Install the CLI's default Ctrl-C handler.
 *
 * *render* prints the interrupt notice; *exit* ends the process. Both are
 * injected so the behaviour is testable without a real signal.
 */
/**
 * The controller the current install aborts. Replaced per install rather than
 * created once at module load: `installDefaultInterrupt` is called fresh in
 * tests, and a single long-lived controller would carry one test's interrupt
 * into the next. The CLI installs exactly once, so the two agree in practice.
 */
let controller = new AbortController();

/**
 * The signal every cancellable core call gets.
 *
 * Aborted on the first Ctrl-C, whether or not a command claimed the signal:
 * standing aside decides who *exits*, not whether the work stops. A command
 * running its own cleanup still wants the core call it is awaiting cancelled.
 */
export function interruptSignal(): AbortSignal {
  return controller.signal;
}

export function installDefaultInterrupt(
  proc: NodeJS.EventEmitter = process,
  render: () => void = () => {},
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  // A second Ctrl-C always ends it, so a command that wedges on its way out can
  // still be killed — the cost of standing aside is at most one more keystroke.
  let standingAside = false;
  controller = new AbortController();
  proc.on("SIGINT", () => {
    controller.abort();
    if (claimed(proc) && !standingAside) {
      standingAside = true;
      return;
    }
    render();
    exit(130);
  });
}
