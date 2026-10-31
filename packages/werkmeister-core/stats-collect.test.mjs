// The sampling loop is the only part of `stats` with control flow, and the only
// part a caller can interrupt. An aborted run must return the samples it already
// has — and, more importantly, must actually stop: without the abort wired into
// both the loop and its sleep, `runCollection` runs for its full duration no
// matter what the caller wants. The `timeout` on each test is what turns that
// hang into a failure; the one-minute request bounds how long a regression
// wedges the suite for.

import assert from "node:assert/strict";
import { test } from "node:test";

import { containerStats } from "./dist/docker.js";
import { runCollection } from "./dist/stats.js";
import { useDockerEngine } from "./fixtures.mjs";

useDockerEngine();

test("an aborted run stops early and reports what it actually did", {
  timeout: 20_000,
}, async () => {
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

// A host-wide snapshot is one request per running container, so on a loaded host
// it alone outlasts the test above. The abort has to reach the requests in flight,
// or the run's length is whatever the daemon makes it.
test("an abort interrupts a snapshot already in flight", { timeout: 20_000 }, async () => {
  const started = Date.now();
  await containerStats(AbortSignal.timeout(100));
  const elapsedSeconds = (Date.now() - started) / 1000;

  assert.ok(elapsedSeconds < 2, `abort must cut the snapshot short, took ${elapsedSeconds}s`);
});

test("a signal already aborted collects nothing", { timeout: 20_000 }, async () => {
  const run = await runCollection(1, 5, false, AbortSignal.abort());

  assert.equal(run.samples, 0);
  assert.deepEqual(run.stats, {});
  assert.deepEqual(run.recommendations, []);
});
