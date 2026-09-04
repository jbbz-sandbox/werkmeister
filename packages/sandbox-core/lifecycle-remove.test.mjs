// removeService is a six-step sequence — regenerate three configs, restart or
// stop containers, regenerate the Caddyfile, reload — and until now it existed
// only inside a command module. Pinned here because the CLI's `remove` is now
// nothing but a banner, two error catches and a summary block.
import { test } from "node:test";
import assert from "node:assert/strict";

import { SandboxError } from "./dist/errors.js";
import { removeService } from "./dist/lifecycle.js";

test("removing from a feature with no slot raises NOT_RUNNING", async () => {
  const err = await removeService("no-such-feature-hopefully", "backend").then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_RUNNING");
  assert.equal(
    err.message,
    "Feature 'no-such-feature-hopefully' is not running (no slot allocated)",
  );
});
