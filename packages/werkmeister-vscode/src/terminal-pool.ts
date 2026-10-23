/**
 * Which terminal a `sandbox` command runs in.
 *
 * Free of any `vscode` import so it runs under `node --test`, the same split
 * build-tree.ts uses to keep the decisions testable without an extension host.
 */

export interface Slot<T> {
  term: T;
  /** Fixed when the terminal is created; reusing across cwds would run the command elsewhere. */
  cwd: string;
  busy: boolean;
}

/**
 * Reuse an idle terminal from the same cwd, else create one.
 *
 * A slot stays busy until the caller releases it, so a terminal that never
 * reports its command finished is never reused — that degrades to one terminal
 * per command rather than typing into a live process's STDIN.
 */
export function claim<T>(slots: Slot<T>[], cwd: string, create: () => T): T {
  let slot = slots.find((s) => !s.busy && s.cwd === cwd);
  if (!slot) {
    slot = { term: create(), cwd, busy: false };
    slots.push(slot);
  }
  slot.busy = true;
  return slot.term;
}

/** Mark the slot holding `term` idle; a terminal we don't own is ignored. */
export function release<T>(slots: Slot<T>[], term: T): void {
  const slot = slots.find((s) => s.term === term);
  if (slot) slot.busy = false;
}

/** Drop a closed terminal — text sent to a disposed terminal goes nowhere, silently. */
export function forget<T>(slots: Slot<T>[], term: T): void {
  const i = slots.findIndex((s) => s.term === term);
  if (i >= 0) slots.splice(i, 1);
}
