// dockerode loads on the first docker() call, not when docker.js is imported: about 300
// modules that half the suite, and every CLI start that never reaches the Engine, would pay for.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { docker } from "../dist/docker.js";

const loaded = () =>
  Object.keys(createRequire(import.meta.url).cache).some((f) => /[\\/]dockerode[\\/]/.test(f));

test("importing docker.js does not load dockerode; the first docker() call does", () => {
  assert.equal(loaded(), false);
  assert.equal(typeof docker().listContainers, "function");
  assert.equal(loaded(), true);
});
