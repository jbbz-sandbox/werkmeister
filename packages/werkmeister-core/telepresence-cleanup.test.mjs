// SW-2's fixture capture left a traffic agent on frontend at ~27% CPU plus
// duplicate daemons, because leaving an intercept only detached it (SW-42).
// These pin what the cleanup after a leave may and may not end: never an agent
// or daemon another feature's intercept still uses, and nothing on a guess.

import assert from "node:assert/strict";
import { test } from "node:test";

import { releaseIdleTelepresence } from "./dist/telepresence.js";

/** A runner answering `list -i` with *intercepted* deployments; records every argv. */
function stub(intercepted, { listRc = 0, listOut, uninstallRc = 0 } = {}) {
  const calls = [];
  const runner = async (cmd) => {
    calls.push(cmd.join(" "));
    if (cmd[1] === "list") {
      const out =
        listOut ??
        JSON.stringify(
          intercepted.map((name) => ({
            name,
            intercept_info: [{ spec: { header_filters: { "x-feature": "other" } } }],
          })),
        );
      return [listRc, out];
    }
    if (cmd[1] === "uninstall") {
      return [uninstallRc, uninstallRc ? "boom" : ""];
    }
    return [0, ""];
  };
  return { runner, calls };
}

const LIST = "telepresence list -i --format json";

test("nothing left, nothing remaining: uninstall the agent, then quit", async () => {
  const { runner, calls } = stub([]);
  const r = await releaseIdleTelepresence(["frontend"], runner);
  assert.deepEqual(calls, [LIST, "telepresence uninstall frontend", "telepresence quit -s"]);
  assert.deepEqual(r, { uninstalled: ["frontend"], quit: true });
});

test("another feature still intercepts the workload: keep its agent and the daemons", async () => {
  const { runner, calls } = stub(["frontend"]);
  const r = await releaseIdleTelepresence(["frontend"], runner);
  assert.deepEqual(calls, [LIST]);
  assert.deepEqual(r, { uninstalled: [], quit: false });
});

test("another workload is still intercepted: uninstall ours, keep the daemons", async () => {
  const { runner, calls } = stub(["backend"]);
  const r = await releaseIdleTelepresence(["frontend"], runner);
  assert.deepEqual(calls, [LIST, "telepresence uninstall frontend"]);
  assert.deepEqual(r, { uninstalled: ["frontend"], quit: false });
});

test("an unreadable intercept list touches nothing", async () => {
  for (const opts of [{ listRc: 1 }, { listOut: "not json" }, { listOut: '{"a":1}' }]) {
    const { runner, calls } = stub([], opts);
    const r = await releaseIdleTelepresence(["frontend"], runner);
    assert.deepEqual(calls, [LIST], JSON.stringify(opts));
    assert.deepEqual(r, { uninstalled: [], quit: false });
  }
});

test("a call that left nothing spawns nothing", async () => {
  const { runner, calls } = stub([]);
  assert.deepEqual(await releaseIdleTelepresence([], runner), { uninstalled: [], quit: false });
  assert.deepEqual(calls, []);
});

test("a failed uninstall doesn't throw", async () => {
  const { runner } = stub(["backend"], { uninstallRc: 1 });
  assert.deepEqual(await releaseIdleTelepresence(["frontend"], runner), {
    uninstalled: [],
    quit: false,
  });
});
