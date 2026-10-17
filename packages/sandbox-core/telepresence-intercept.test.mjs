// The command's fail() called process.exit(1). In-process that kills the host
// server, which is why no server could call this route without spawning the CLI.
// Every rejection is now a coded SandboxError.

import assert from "node:assert/strict";
import { test } from "node:test";

import { SandboxError } from "./dist/errors.js";
import { leaveIntercept, portOpen, startIntercept } from "./dist/telepresence.js";

const base = { feature: "demo", localServices: ["backend"] };

test("a service the workspace does not run locally raises NOT_LOCAL", async () => {
  const err = await startIntercept({
    ...base,
    service: "frontend",
    localServices: ["backend"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_LOCAL");
  // The message is CLI output and must not drift.
  assert.equal(
    err.message,
    "'frontend' is not a local service of this workspace (SERVICES=backend). " +
      "Add it to workspace.yml services and rerun `sandbox init-workspace`.",
  );
});

test("an empty SERVICES list still names the empty set", async () => {
  const err = await startIntercept({ ...base, service: "nope", localServices: [] }).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.code, "NOT_LOCAL");
  assert.match(err.message, /SERVICES=\(none\)/);
});

test("startIntercept never calls process.exit", async () => {
  // If it did, this test file would die here rather than report a failure.
  await startIntercept({ ...base, service: "nope", localServices: [] }).catch(() => {});
  assert.ok(true);
});

test("leaveIntercept validates the service the same way", async () => {
  const err = await leaveIntercept({
    ...base,
    service: "frontend",
    localServices: ["backend"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof SandboxError, `expected SandboxError, got ${err}`);
  assert.equal(err.code, "NOT_LOCAL");
});

test("portOpen resolves false for a closed port rather than hanging", async () => {
  assert.equal(await portOpen(1, 200), false);
});
