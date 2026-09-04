/**
 * Who owns Ctrl-C.
 *
 * The regression this guards is silent: the default handler was registered
 * first and exited immediately, so `sandbox open`'s cleanup — close the browser
 * window, remove the throwaway profile — never ran, and nothing said so. The
 * only visible symptom was a leftover Chrome and a directory in $TMPDIR.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { installDefaultInterrupt, interruptSignal } from "../interrupt.js";

/** A stand-in for `process`, recording what the handler would have done. */
function harness() {
  const proc = new EventEmitter();
  const exits: number[] = [];
  const renders: number[] = [];
  installDefaultInterrupt(
    proc,
    () => renders.push(1),
    (code) => exits.push(code),
  );
  return { proc, exits, renders, signal: interruptSignal() };
}

describe("installDefaultInterrupt", () => {
  it("exits 130 when no command claimed the signal", () => {
    const { proc, exits, renders } = harness();
    proc.emit("SIGINT");
    expect(exits).toEqual([130]);
    expect(renders).toEqual([1]);
  });

  it("stands aside for a command that claimed it, letting its cleanup run", () => {
    const { proc, exits, renders } = harness();
    const cleanup: string[] = [];
    proc.on("SIGINT", () => cleanup.push("stopped"));

    proc.emit("SIGINT");

    expect(exits).toEqual([]); // the whole point: no exit out from under it
    expect(renders).toEqual([]); // and the command prints its own notice
    expect(cleanup).toEqual(["stopped"]);
  });

  it("forces the exit on a second Ctrl-C, so a wedged command is still killable", () => {
    const { proc, exits } = harness();
    proc.on("SIGINT", () => {
      /* a command that never finishes winding down */
    });

    proc.emit("SIGINT");
    expect(exits).toEqual([]);

    proc.emit("SIGINT");
    expect(exits).toEqual([130]);
  });

  it("exits normally once the command has released the signal", () => {
    const { proc, exits } = harness();
    const onSignal = () => {};
    proc.on("SIGINT", onSignal);
    proc.off("SIGINT", onSignal); // what `open.ts`'s finally does

    proc.emit("SIGINT");
    expect(exits).toEqual([130]);
  });
});

describe("interruptSignal", () => {
  it("is unaborted until a signal arrives, then aborted", () => {
    const { proc, signal } = harness();
    expect(signal.aborted).toBe(false);

    proc.emit("SIGINT");

    expect(signal.aborted).toBe(true);
  });

  it("aborts even when a command claimed the signal for its own cleanup", () => {
    const { proc, signal, exits } = harness();
    proc.on("SIGINT", () => {
      /* a command doing its own teardown */
    });

    proc.emit("SIGINT");

    // Standing aside is about who exits, not about whether the work stops: the
    // command still wants the core call it is awaiting to be cancelled.
    expect(exits).toEqual([]);
    expect(signal.aborted).toBe(true);
  });

  it("gives each install its own signal, so one interrupt cannot poison the next", () => {
    const first = harness();
    first.proc.emit("SIGINT");
    expect(first.signal.aborted).toBe(true);

    const second = harness();
    expect(second.signal.aborted).toBe(false);
  });
});
