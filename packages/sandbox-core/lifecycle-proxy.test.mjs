// reloadProxy has two callers with different needs: `down` wants a reload only,
// `proxy-reload` wants Caddy started if it is down and the feature list printed.
// The default must stay the teardown spelling or `sandbox down` grows output it
// never had — and starts a proxy nobody asked for.
//
// This one talks to the real Caddyfile rather than a fixture, which is against
// this suite's usual "API calls are integration territory" line. It is the same
// regenerate-and-reload `sandbox proxy-reload` performs, it is idempotent, and
// the file it writes is gitignored — and there is no seam to fake, because the
// feature list is read back out of the slots the generator just used.
//
// `started` is deliberately not the assertion for the default: it can only ever
// be true with Caddy down, so on a machine running Caddy it passes either way.
// The transcript is what actually separates the two spellings.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";

// Pinned to this checkout before `lifecycle` is imported: a shell that exports
// SANDBOX_ROOT (`~/.sandbox/env.sh` does) would otherwise have the test write
// some *other* checkout's Caddyfile — the shared one, when this runs from a
// worktree.
process.env.SANDBOX_ROOT = path.join(import.meta.dirname, "..", "..", "apps", "cli");

const { reloadProxy } = await import("./dist/lifecycle.js");

async function transcript(opts) {
  const reporter = collectingReporter();
  const result = await withReporter(reporter, () => reloadProxy(opts));
  return { result, text: reporter.text() };
}

test("reloadProxy reports the active features it wrote into the Caddyfile", async () => {
  const { result } = await transcript();
  assert.ok(Array.isArray(result.features));
  assert.equal(typeof result.ok, "boolean");
  for (const f of result.features) {
    assert.equal(typeof f.feature, "string");
    assert.equal(typeof f.slot, "number");
    assert.ok(Array.isArray(f.services));
  }
  // Sorted by feature name: the CLI renders the list in the order it is given.
  const names = result.features.map((f) => f.feature);
  assert.deepEqual(names, [...names].sort());
});

test("the default is the teardown spelling: no feature list, no start", async () => {
  const { result, text } = await transcript();
  assert.match(text, /Updating reverse proxy configuration/);
  assert.doesNotMatch(text, /Regenerating Caddyfile/);
  assert.doesNotMatch(text, /Features in Caddyfile/);
  assert.equal(result.started, false);
});

test("start: true is the proxy-reload spelling, and lists what it wrote", async () => {
  const { result, text } = await transcript({ start: true });
  assert.match(text, /Regenerating Caddyfile/);
  assert.doesNotMatch(text, /Updating reverse proxy configuration/);
  if (result.features.length) {
    assert.match(text, /Features in Caddyfile/);
    for (const f of result.features) {
      assert.match(text, new RegExp(`${f.feature} \\(slot ${f.slot}\\):`));
    }
  } else {
    assert.match(text, /No active features in Caddyfile/);
  }
});
