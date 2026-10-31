// SW-222: a workspace with no services must still render a compose file whose
// `services:` is a mapping; a bare `services:` parses as null and compose rejects it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { generateFeatureCompose } from "./dist/generate.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("a workspace with no services renders services as an empty mapping", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "no-services-ws-"));
  try {
    const compose = await withSandboxHome(async () =>
      YAML.parse(fs.readFileSync(generateFeatureCompose("f", 1, [], null, ws), "utf8")),
    );
    assert.deepEqual(compose.services, {});
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
