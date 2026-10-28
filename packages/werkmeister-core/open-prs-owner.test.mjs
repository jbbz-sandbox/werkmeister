// SW-120: the Open PRs tab searches the configured GitHub org, not a hard-coded
// owner. `gh` is a shim in a temp HOME's ~/.local/bin, which childEnv() puts first
// on PATH (a PATH prefix would lose to /usr/local/bin/gh); nothing reaches GitHub.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getOpenPrs } from "./dist/sandbox.js";
import { withSandboxHome } from "./fixtures.mjs";

async function withShimGh(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shim-gh-"));
  const dir = path.join(home, ".local", "bin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1 $2" in
  "api user") echo octo;;
  "search prs") echo '[]';;
esac
`,
    { mode: 0o755 },
  );
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(() => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"));
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("getOpenPrs searches the configured github_org", async () => {
  await withSandboxHome(
    async () => {
      await withShimGh(async (calls) => {
        await getOpenPrs();
        const searches = calls().filter((c) => c.startsWith("search prs"));
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
    await withShimGh(async (calls) => {
      await assert.rejects(getOpenPrs(), /overrides\.github_org/);
      assert.deepEqual(
        calls().filter((c) => c.startsWith("search")),
        [],
      );
    });
  });
});
