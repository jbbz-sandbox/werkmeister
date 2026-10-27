// Smoke test for werkmeister-core/cache: persistence, TTL, stale-while-revalidate,
// atomic merge, refresh bypass, failure-is-not-stored.
//   npm run build && node lib/cache.smoke.mjs
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cache-"));
const cacheFile = path.join(tmp, "jira-cache.json");
process.env.WERKMEISTER_CACHE_FILE = cacheFile;

// WERKMEISTER_CACHE_FILE must be set before the module loads — hence the dynamic import.
const { cacheGet, cacheSet, withCache, runBatchOnce } = await import("werkmeister-core/cache");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for `predicate` rather than for a fixed delay.
 *
 * Both places this replaces slept 50-60ms for a background job to land, which
 * is ample on an idle machine and not ample under a full `turbo run test`.
 * Polling makes the wait as long as it needs to be and no longer.
 */
async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// 1. cold miss → fetcher runs, value stored + returned
let calls = 0;
let v = await withCache("status:A", 1000, async () => {
  calls++;
  return "up";
});
assert.equal(v, "up");
assert.equal(calls, 1);
assert.deepEqual((await cacheGet("status:A")).v, "up");

// 2. fresh hit → fetcher NOT called
v = await withCache("status:A", 1000, async () => {
  calls++;
  return "changed";
});
assert.equal(v, "up");
assert.equal(calls, 1);

// 3. persistence across "processes": a fresh readStore sees it on disk
assert.ok(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))["status:A"]);

// 4. stale → returns stale synchronously AND background-refreshes the store
await cacheSet("status:B", "old");
// force staleness by rewriting `at` into the past
const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
raw["status:B"].at = Date.now() - 10_000;
fs.writeFileSync(cacheFile, JSON.stringify(raw));
let bgCalls = 0;
v = await withCache("status:B", 1000, async () => {
  bgCalls++;
  return "new";
});
assert.equal(v, "old"); // served stale immediately
await waitFor(async () => (await cacheGet("status:B")).v === "new", "the background refresh");
assert.equal(bgCalls, 1);
assert.equal((await cacheGet("status:B")).v, "new"); // background updated the store

// 5. refresh:true → bypass a fresh entry
v = await withCache("status:A", 1000, async () => "refreshed", { refresh: true });
assert.equal(v, "refreshed");
assert.equal((await cacheGet("status:A")).v, "refreshed");

// 6. failed fetch (undefined) → nothing stored, no throw
v = await withCache("status:C", 1000, async () => undefined);
assert.equal(v, undefined);
assert.equal(await cacheGet("status:C"), undefined);

// 7. stored null is a real value, not a failure
await cacheSet("briefing:X", null);
v = await withCache("briefing:X", 1000, async () => {
  throw new Error("should not fetch");
});
assert.equal(v, null);

// 8. concurrent merge → both keys survive
await Promise.all([cacheSet("status:D", "d"), cacheSet("status:E", "e")]);
const merged = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
assert.ok(merged["status:D"] && merged["status:E"]);

// 9. runBatchOnce dedupes in-flight keys
let batch = 0;
runBatchOnce(["k1", "k2"], async () => {
  batch++;
  await sleep(30);
});
runBatchOnce(["k1"], async () => {
  batch++;
  await sleep(30);
}); // k1 in-flight → skipped
await waitFor(() => batch > 0, "the batch job to start");
await sleep(60); // and then long enough that a second, wrongly-admitted job would have run too
assert.equal(batch, 1);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("cache.smoke: OK");
