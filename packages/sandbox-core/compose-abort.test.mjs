// The async compose path exists so `up` and `down` can be cancelled by a caller
// that is not a dying CLI process. Its risk is divergence: two spellings of the
// same command that drift in what they print. So the assertions here are
// parity assertions -- the async form must emit byte-identical output to the
// sync form it shadows, for the same input.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import {
  composeDown,
  composeDownAsync,
  composeUp,
  composeUpAsync,
} from "./dist/compose.js";

const FEATURE = "no-such-feature-hopefully";

/** Run `fn` under a fresh collecting reporter; return [returnValue, emittedText]. */
async function capture(fn) {
  const reporter = collectingReporter();
  const value = await withReporter(reporter, async () => fn());
  return [value, reporter.text()];
}

test("composeUpAsync emits exactly what composeUp emits, and returns the same", async () => {
  const [syncValue, syncText] = await capture(() => composeUp(FEATURE));
  const [asyncValue, asyncText] = await capture(() => composeUpAsync(FEATURE));

  assert.equal(asyncValue, syncValue);
  assert.equal(asyncText, syncText);
});

test("composeDownAsync emits exactly what composeDown emits, and returns the same", async () => {
  const [syncValue, syncText] = await capture(() => composeDown(FEATURE));
  const [asyncValue, asyncText] = await capture(() => composeDownAsync(FEATURE));

  assert.equal(asyncValue, syncValue);
  assert.equal(asyncText, syncText);
});

test("an already-aborted signal is not an exception", async () => {
  const ac = new AbortController();
  ac.abort();
  // The contract is a boolean, not a throw: lifecycle.up branches on it, and a
  // cancelled start must read as "did not start", not crash the caller.
  assert.equal(await composeUpAsync(FEATURE, ac.signal), false);
});
