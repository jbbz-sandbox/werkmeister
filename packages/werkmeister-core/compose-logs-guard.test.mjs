// The slot guard was the only logic in commands/logs.ts. Moved here so the
// command holds nothing but its banner -- and so any caller, not just the CLI,
// gets told why a tail produced nothing instead of a bare compose error.
//
// Hermetic: `getSlot` reads the service registry, which does not exist on a
// clean machine, so the whole test runs against a seeded temp sandbox home.

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeLogs } from "./dist/compose.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { withSandboxHome } from "./fixtures.mjs";

test("composeLogs warns and does not spawn when the feature holds no slot", async () => {
  const text = await withSandboxHome(async () => {
    const reporter = collectingReporter();
    await withReporter(reporter, () => composeLogs("no-such-feature-hopefully"));
    return reporter.text();
  });

  assert.match(text, /is not running \(no slot allocated\)/);
  assert.match(text, /Start it with: sandbox up no-such-feature-hopefully/);
  // The point of the guard: no compose invocation is announced, because none
  // was attempted. Without it the caller gets a bare "no compose.yml".
  assert.doesNotMatch(text, /Running: docker compose/);
});
