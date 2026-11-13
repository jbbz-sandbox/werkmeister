// SW-658: what `npm publish` would ship. dist/ is gitignored, so without a `files`
// list npm drops it and packs the test files instead.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const dir = fileURLToPath(new URL(".", import.meta.url));

test("the tarball holds the SDK build, README, LICENSE and NOTICE, and no tests or sources", async () => {
  // --ignore-scripts: no lifecycle script may run (or rebuild) during a test.
  const { stdout } = await promisify(execFile)(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: dir },
  );
  const [{ files }] = JSON.parse(stdout);
  const paths = files.map((f) => f.path);
  for (const p of [
    "dist/sdk.js",
    "dist/sdk.d.ts",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "package.json",
  ]) {
    assert.ok(paths.includes(p), `${p} missing from the tarball`);
  }
  assert.deepEqual(
    paths.filter((p) => /\.(test|smoke)\.mjs$|^src\/|^tsconfig\.json$/.test(p)),
    [],
  );
});

test("package.json publishes publicly", async () => {
  const { default: pkg } = await import("./package.json", { with: { type: "json" } });
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig?.access, "public");
});
