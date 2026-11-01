// SW-177: the "test" script points WERKMEISTER_GH_BIN at no-gh.sh, so a test
// that forgets withFakeGh fails instead of reaching the host's real gh.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCapture } from "./dist/tool_bins.js";
import { withFakeGh } from "./fixtures.mjs";

const stubbed = async () => (await runCapture("gh", ["pr", "list"])).stderr;

test("gh fails closed outside withFakeGh", async () => {
  assert.match(await stubbed(), /gh called outside withFakeGh: pr list/);
});

test("withFakeGh overrides the stub and puts it back", async () => {
  await withFakeGh({}, async () => {
    assert.match(await stubbed(), /fake gh: unhandled: pr list/);
  });
  assert.match(await stubbed(), /gh called outside withFakeGh/);
});
