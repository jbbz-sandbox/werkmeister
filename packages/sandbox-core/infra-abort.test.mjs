// `connect` rebuilds the k8s-forwards image, which routinely runs for minutes.
// A caller that has already cancelled must not have infrastructure started
// underneath it -- so the guard has to come before any of up()'s setup work,
// not just before the compose spawn.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { up } from "./dist/infra.js";

test("up refuses an already-aborted signal before doing any work", async () => {
  const ac = new AbortController();
  ac.abort();

  const started = Date.now();
  const reporter = collectingReporter();
  const ok = await withReporter(reporter, () => up({ signal: ac.signal }));
  const elapsed = Date.now() - started;

  assert.equal(ok, false);
  // Real work here is git config, proxy-file generation, a CA extract and a
  // docker build -- seconds at best. Returning fast is what proves the guard
  // sits ahead of all of it rather than merely ahead of the spawn.
  assert.ok(elapsed < 500, `took ${elapsed}ms; the guard is not first`);
});
