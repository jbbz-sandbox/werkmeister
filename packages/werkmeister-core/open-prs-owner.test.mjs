// SW-120: the Open PRs tab searches the configured GitHub org, not a hard-coded
// owner. `gh` is withFakeGh's fake, reached through $WERKMEISTER_GH_BIN (SW-148);
// nothing reaches GitHub.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runCapture } from "./dist/claude_cli.js";
import { getOpenPrs } from "./dist/sandbox.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

const callsOf = (bin) =>
  fs
    .readFileSync(path.join(path.dirname(bin), "calls"), "utf8")
    .trim()
    .split("\n");

test("getOpenPrs searches the configured github_org", async () => {
  await withSandboxHome(
    async () => {
      await withFakeGh({}, async (bin) => {
        await getOpenPrs();
        const calls = callsOf(bin);
        assert.equal(calls[0], "api user --jq .login");
        const searches = calls.filter((c) => c.startsWith("search prs"));
        assert.equal(searches.length, 2);
        for (const s of searches) {
          assert.match(s, /--owner=acme-corp(\s|$)/);
          assert.doesNotMatch(s, /--owner=sandbox/);
        }
      });
    },
    { config: "overrides:\n  github_org: acme-corp\n" },
  );
});

test("getOpenPrs refuses to search without a known github_org", async () => {
  await withSandboxHome(async () => {
    await withFakeGh({}, async (bin) => {
      await assert.rejects(getOpenPrs(), /overrides\.github_org/);
      assert.deepEqual(
        callsOf(bin).filter((c) => c.startsWith("search")),
        [],
      );
    });
  });
});

test("runCapture's gh is the fake, which fails closed on a subcommand it doesn't cover", async () => {
  await withFakeGh({}, async (bin) => {
    const res = await runCapture("gh", ["repo", "delete", "acme-corp/x"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /fake gh: unhandled: repo delete/);
    assert.deepEqual(callsOf(bin), ["repo delete acme-corp/x"]);
  });
});
