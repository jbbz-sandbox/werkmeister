/**
 * The ambient log sink for this library.
 *
 * Library modules used to print straight to the console, which is what kept
 * them unimportable by `sandbox mcp --stdio`: that server uses stdout as the
 * MCP JSON-RPC transport, so one `info()` corrupts the protocol stream. They
 * now emit events and the caller decides where those go.
 *
 * Scoped through AsyncLocalStorage rather than a module-level emitter because
 * the MCP server runs tool calls concurrently — a shared emitter interleaves
 * their output with no way to demultiplex it, and a correlation id would have
 * to be threaded through the same call chain this replaces.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { CYAN, GREEN, RED, RESET, YELLOW } from "./colors.js";

export type LogEvent =
  | { level: "info" | "ok" | "warn" | "error"; msg: string }
  | { level: "raw"; chunk: string; stream: "stdout" | "stderr" };

export interface Reporter {
  emit(event: LogEvent): void;
  /** True when the caller owns a TTY and wants child processes to inherit it. */
  passthrough: boolean;
}

const storage = new AsyncLocalStorage<Reporter>();

/** Run `fn` with `reporter` as the ambient sink for everything it calls. */
export function withReporter<T>(reporter: Reporter, fn: () => Promise<T>): Promise<T> {
  return storage.run(reporter, fn);
}

// Silent when nothing is installed: importing this library from a script must
// neither crash nor print. A forgotten withReporter() then shows up as missing
// output, which is noticeable, rather than as a crash or a corrupted stream.
function emit(event: LogEvent): void {
  storage.getStore()?.emit(event);
}

export function info(msg: string): void {
  emit({ level: "info", msg });
}

export function success(msg: string): void {
  emit({ level: "ok", msg });
}

export function warn(msg: string): void {
  emit({ level: "warn", msg });
}

export function error(msg: string): void {
  emit({ level: "error", msg });
}

/**
 * Emit bytes with no level prefix — section headers, blank spacers, and echoed
 * child-process output, which the four helpers above would tag with `[info]`.
 *
 * *chunk* is written verbatim, so a caller replacing a `console.log` supplies
 * the trailing newline that `console.log` used to add.
 */
export function raw(chunk: string, stream: "stdout" | "stderr" = "stdout"): void {
  emit({ level: "raw", chunk, stream });
}

// Padded so the messages after the tag line up.
const PREFIX = {
  info: `${CYAN}[info] `,
  ok: `${GREEN}[ok]   `,
  warn: `${YELLOW}[warn] `,
  error: `${RED}[err]  `,
} as const;

/**
 * What `apps/cli/src/lib/config.ts` printed before the indirection existed,
 * byte for byte: the whole line carries the level colour (so any `Colors.`
 * a message embeds resets to plain, not back to the level colour), and
 * `error` goes to stdout like the rest.
 */
export const ttyReporter: Reporter = {
  passthrough: true,
  emit(event) {
    if (event.level === "raw") {
      process[event.stream].write(event.chunk);
      return;
    }
    console.log(`${PREFIX[event.level]}${event.msg}${RESET}`);
  },
};
