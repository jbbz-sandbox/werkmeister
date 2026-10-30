// SW-151: memswap_limit equals the memory limit wherever one is rendered, so a
// limit holds the same on hosts with and without swap.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { generateFeatureCompose } from "./dist/generate.js";
import { withSandboxHome } from "./fixtures.mjs";

test("every service with a memory limit gets memswap_limit equal to it", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "memswap-ws-"));
  fs.mkdirSync(path.join(ws, "demo-repo"));
  try {
    const compose = await withSandboxHome(async () =>
      YAML.parse(fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, ws), "utf8")),
    );
    const limited = Object.entries(compose.services).filter(
      ([, s]) => s.deploy?.resources?.limits?.memory,
    );
    assert.ok(limited.length >= 2, "setup and backend at least");
    for (const [name, s] of limited) {
      assert.equal(s.memswap_limit, s.deploy.resources.limits.memory, name);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
