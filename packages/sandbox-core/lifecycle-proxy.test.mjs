// reloadProxy has two callers with different needs: `down` wants a reload only,
// `proxy-reload` wants Caddy started if it is down and the feature list printed.
// The default must stay the teardown spelling or `sandbox down` grows output it
// never had — and starts a proxy nobody asked for.
//
// Driven through `ProxyOps` rather than the real Caddyfile. The earlier spelling
// of this file called the real `reloadProxy`, so running the unit suite on a
// configured machine regenerated `infra/proxy/Caddyfile` and reloaded a live
// Caddy — and to keep CI green it skipped itself whenever `~/.sandbox` was
// absent, which is every CI run. With the ops injected it touches nothing, runs
// everywhere, and can assert the branches a real machine only reaches by luck:
// `started` is meaningless against a real Caddy that is already up.

import assert from "node:assert/strict";
import { test } from "node:test";
import { reloadProxy } from "./dist/lifecycle.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";

/** Two features, deliberately out of order: reloadProxy owes the caller a sort. */
const SLOTS = {
  zebra: { slot: 4, services: ["backend"] },
  alpha: { slot: 2, services: ["backend", "frontend"] },
};

/** Real ops replaced by recorders. `calls` is the sequence, for ordering. */
function fakeOps({ slots = SLOTS, running = true, reload = true, start = true } = {}) {
  const calls = [];
  return {
    calls,
    generate: async () => {
      calls.push("generate");
      return "/tmp/Caddyfile";
    },
    slots: async () => {
      calls.push("slots");
      return slots;
    },
    running: () => {
      calls.push("running");
      return running;
    },
    reload: async () => {
      calls.push("reload");
      return reload;
    },
    start: () => {
      calls.push("start");
      return start;
    },
  };
}

async function transcript(opts, ops) {
  const reporter = collectingReporter();
  const result = await withReporter(reporter, () => reloadProxy(opts, ops));
  return { result, text: reporter.text() };
}

test("reloadProxy reports the active features it wrote into the Caddyfile", async () => {
  const { result } = await transcript(undefined, fakeOps());
  assert.deepEqual(result.features, [
    { feature: "alpha", slot: 2, services: ["backend", "frontend"] },
    { feature: "zebra", slot: 4, services: ["backend"] },
  ]);
  assert.equal(result.ok, true);
});

test("the Caddyfile is regenerated before the slots are read back", async () => {
  // The feature list must describe the file just written, not the one it replaced.
  const ops = fakeOps();
  await transcript(undefined, ops);
  assert.deepEqual(ops.calls, ["generate", "slots", "running", "reload"]);
});

test("the default is the teardown spelling: no feature list, no start", async () => {
  const { result, text } = await transcript(undefined, fakeOps());
  assert.match(text, /Updating reverse proxy configuration/);
  assert.doesNotMatch(text, /Regenerating Caddyfile/);
  assert.doesNotMatch(text, /Features in Caddyfile/);
  assert.equal(result.started, false);
});

test("the default never starts a proxy nobody asked for", async () => {
  // The branch a machine already running Caddy can never reach.
  const ops = fakeOps({ running: false });
  const { result, text } = await transcript(undefined, ops);
  assert.ok(!ops.calls.includes("start"), "teardown started Caddy");
  assert.equal(result.started, false);
  assert.match(text, /skipping reload/);
});

test("start: true is the proxy-reload spelling, and lists what it wrote", async () => {
  const { result, text } = await transcript({ start: true }, fakeOps());
  assert.match(text, /Regenerating Caddyfile/);
  assert.doesNotMatch(text, /Updating reverse proxy configuration/);
  assert.match(text, /Features in Caddyfile/);
  for (const f of result.features) {
    assert.match(text, new RegExp(`${f.feature} \\(slot ${f.slot}\\):`));
  }
});

test("start: true with no active features says so instead of listing none", async () => {
  const { result, text } = await transcript({ start: true }, fakeOps({ slots: {} }));
  assert.deepEqual(result.features, []);
  assert.match(text, /No active features in Caddyfile/);
  assert.doesNotMatch(text, /Features in Caddyfile/);
});

test("start: true starts Caddy when it is down, and says which it did", async () => {
  const ops = fakeOps({ running: false });
  const { result, text } = await transcript({ start: true }, ops);
  assert.equal(result.started, true);
  assert.equal(result.ok, true);
  assert.ok(ops.calls.includes("start") && !ops.calls.includes("reload"));
  assert.match(text, /Caddy is not running -- starting it/);
});

test("a Caddy that rejects the config reports ok: false, not a throw", async () => {
  // proxy-reload maps `ok` to its exit code; a throw would lose the transcript.
  const { result } = await transcript({ start: true }, fakeOps({ reload: false }));
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
});

test("a failed start reports ok: false and still counts as started", async () => {
  const { result } = await transcript({ start: true }, fakeOps({ running: false, start: false }));
  assert.equal(result.ok, false);
  assert.equal(result.started, true);
});
