/**
 * Every argv the extension sends must parse in the built CLI without a deprecation line.
 * SW-186 renamed the CLI into noun groups and the old spellings go in 0.58.0; the unit tests
 * only checked terminal names, so a stale argv array broke silently.
 * Needs `pnpm turbo run build --filter=werkmeister` first (turbo's `test` depends on `build`).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ALL_ARGV } from "../out/argv.js";

const MAIN = fileURLToPath(new URL("../../../apps/cli/dist/main.js", import.meta.url));
const run = promisify(execFile);

for (const argv of ALL_ARGV) {
  test(`werkmeister ${argv.join(" ")}`, async () => {
    assert.ok(
      existsSync(MAIN),
      `${MAIN} is missing: run pnpm turbo run build --filter=werkmeister`,
    );
    const { stderr } = await run(process.execPath, [MAIN, "__parse", ...argv]);
    assert.doesNotMatch(stderr, /deprecat/i, stderr);
  });
}
