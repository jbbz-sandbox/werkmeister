// The local-vs-k8s endpoint decision was the only logic in commands/services.ts.
// It is pinned here so the CLI is left holding nothing but padEnd.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyEndpoint } from "./dist/slots.js";
import { withSandboxHome } from "./fixtures.mjs";

// Hermetic: the local branch resolves a slot port through ports.yaml, which a
// clean machine does not have.
test("a locally-running service reports its slot port", async () => {
  const e = await withSandboxHome(async () =>
    classifyEndpoint("backend", { port_offset: 2, type: "api" }, ["backend"], 3));
  assert.equal(e.source, "local");
  assert.equal(e.type, "api");
  assert.match(e.endpoint, /^localhost:\d+$/);
});

test("a service not running locally falls back to its k8s forward port", () => {
  const e = classifyEndpoint("redis", { k8s_forward_port: 9050, type: "cache" }, [], 3);
  assert.deepEqual(
    { source: e.source, endpoint: e.endpoint },
    { source: "k8s", endpoint: "localhost:9050" },
  );
});

test("a service with neither a local container nor a forward is unconfigured", () => {
  const e = classifyEndpoint("ghost", { type: "api" }, [], 3);
  assert.equal(e.source, "none");
  assert.equal(e.endpoint, null);
});
