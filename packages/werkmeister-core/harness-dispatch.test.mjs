// SW-384: a workspace's sessions follow its `harness:`; the status row says which harness it is.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withFixtureWorkspace, writeSessionState } from "./fixtures.mjs";

const { harnessFor, harnessIdOf } = await import("./dist/harness/layout.js");

const setHarness = (ws, value) => {
  const file = path.join(ws, ".werkmeister", "workspace.yml");
  const body = fs.readFileSync(file, "utf-8").replace(/^harness:.*\n/m, "");
  fs.writeFileSync(file, value === null ? body : `${body}harness: ${value}\n`);
};

test("harnessFor follows workspace.yml; absent, mcp and junk read as claude", () =>
  withFixtureWorkspace(async ({ workspace }) => {
    setHarness(workspace, "codex");
    assert.equal(harnessFor(workspace).id, "codex");
    for (const v of [null, "claude", "mcp", "nonsense"]) {
      setHarness(workspace, v);
      assert.equal(harnessFor(workspace).id, "claude", String(v));
    }
    assert.equal(harnessIdOf(path.join(workspace, "no-such-dir")), "claude");
  }));

test("a codex workspace's status row carries harness and its hooks' agent state", () =>
  withFixtureWorkspace(async ({ workspace }) => {
    setHarness(workspace, "codex");
    writeSessionState(workspace, "needs-you", { question: "Ship it?", at: "2026-11-05T10:00:00Z" });
    const { getWorkspaceStatuses } = await import("./dist/sandbox.js");
    const row = (await getWorkspaceStatuses()).statuses.find(
      (w) => w.name === path.basename(workspace),
    );
    assert.equal(row.harness, "codex");
    assert.equal(row.claude.agent, "needs-you");
    assert.equal(row.claude.question, "Ship it?");
  }));
