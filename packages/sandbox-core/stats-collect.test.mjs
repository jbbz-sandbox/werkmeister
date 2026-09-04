// The sampling loop is the only part of `stats` with control flow, and the only
// part a caller can interrupt. An aborted run must return the samples it already
// has — and, more importantly, must actually stop: without the abort wired into
// both the loop and its sleep, `runCollection` runs for its full duration no
// matter what the caller wants. The `timeout` on each test is what turns that
// hang into a failure; the one-minute request bounds how long a regression
// wedges the suite for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runCollection } from "./dist/stats.js";

test("an aborted run stops early and reports what it actually did", { timeout: 20_000 }, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);

  const started = Date.now();
  const run = await runCollection(1, 5, false, ac.signal);
  const elapsedSeconds = (Date.now() - started) / 1000;

  assert.ok(elapsedSeconds < 10, `abort must cut the loop short, took ${elapsedSeconds}s`);
  assert.ok(run.durationMinutes < 1, "an aborted run must report its real duration");
  assert.equal(run.saved, false);
  assert.ok(run.samples >= 0);
  assert.equal(run.reportPath, null);
});

test("a signal already aborted collects nothing", { timeout: 20_000 }, async () => {
  const run = await runCollection(1, 5, false, AbortSignal.abort());

  assert.equal(run.samples, 0);
  assert.deepEqual(run.stats, {});
  assert.deepEqual(run.recommendations, []);
});
