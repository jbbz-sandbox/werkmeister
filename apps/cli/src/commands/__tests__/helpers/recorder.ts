/**
 * A `Reporter` that keeps what a command emitted, in order, so a test can
 * assert on the sequence rather than on a spy per helper.
 *
 * Extracted at the fourth copy, which `stop_restart.test.ts` said would be the
 * trigger. It covers the two command suites only: `lib/__tests__/slots.test.ts`
 * keeps its own because it is testing the library rather than a command, and
 * `werkmeister-core/reporter.test.mjs` is another package and plain `.mjs`, so it
 * could never have imported this.
 */
import type { Reporter } from "werkmeister-core/reporter";

/**
 * `lines` collects reporter events as `[level] msg`, and `raw` chunks verbatim
 * so a byte-exact unprefixed write can be asserted the way it is emitted.
 */
export function makeRecorder(): { lines: string[]; reporter: Reporter } {
  const lines: string[] = [];
  return {
    lines,
    reporter: {
      passthrough: false,
      emit: (e) => {
        lines.push(e.level === "raw" ? e.chunk : `[${e.level}] ${e.msg}`);
      },
    },
  };
}
