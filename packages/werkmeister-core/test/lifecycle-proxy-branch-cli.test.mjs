// SW-555: its own process, not shared-process.list, since it sets process.env for reloadProxy to read.
import assert from "node:assert/strict";
import { test } from "node:test";

import { reloadProxy } from "../dist/lifecycle.js";
import { collectingReporter, withReporter } from "../dist/reporter.js";

test("under internal branch-cli the shared Caddyfile is neither written nor reloaded (SW-555)", async () => {
  const calls = [];
  const record = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  const ops = {
    hosts: () => [],
    lookup: async () => [],
    generate: record("generate", "/tmp/Caddyfile"),
    slots: record("slots", {}),
    running: () => calls.push("running") && true,
    reload: record("reload", true),
    start: () => calls.push("start") && true,
  };
  process.env.WERKMEISTER_BRANCH_CLI = "1";
  const reporter = collectingReporter();
  const result = await withReporter(reporter, () => reloadProxy({ start: true }, ops));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { features: [], started: false, ok: true });
  assert.match(reporter.text(), /werkmeister infra proxy-reload/);
});
