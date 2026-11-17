// SW-673: the UIs-page demo seed (scripts/docs-demo-home.sh) must keep reading as working /
// needs-you / done through the session reader, or the screenshots quietly show "Idle".

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const { agentOf, readSessions } = await import("../dist/agent_state.js");

const script = fileURLToPath(new URL("../../../scripts/docs-demo-home.sh", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-demo-seed-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// TMPDIR keeps the script's own `mktemp -d` inside tmp, so nothing is left behind.
const run = spawnSync("sh", [script, path.join(tmp, "features")], {
  env: { ...process.env, TMPDIR: tmp },
  encoding: "utf8",
});

const agent = (name) => agentOf(readSessions(path.join(tmp, "features", name)));

test("the seed script runs", () => {
  assert.equal(run.status, 0, run.stderr);
});

test("demo-12 reads as working", () => {
  assert.equal(agent("demo-12-checkout-retry")?.agent, "working");
});

test("demo-15 reads as needs-you with its question", () => {
  const a = agent("demo-15-search-facets");
  assert.equal(a?.agent, "needs-you");
  assert.equal(a.question, "Should the facet panel collapse on phone widths?");
});

test("demo-19 reads as done", () => {
  assert.equal(agent("demo-19-login-copy")?.agent, "done");
});
