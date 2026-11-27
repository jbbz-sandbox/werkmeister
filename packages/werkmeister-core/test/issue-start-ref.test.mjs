// SW-1085: `issue start <ref>` starts that issue; the bare form keeps the workspace's own; only the bare form is pre-approved autonomously.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "../dist/config.js";
import { AUTONOMOUS_RULES } from "../dist/harness/claude/hooks_gen.js";
import { resolveIssueStatuses, startIssue } from "../dist/issue_status.js";
import { withSandboxHome } from "./fixtures.mjs";

const JIRA = resolveIssueStatuses({}, "jira");

/** Every issue reads To Do; records each update. */
function tracker() {
  const updates = [];
  return {
    updates,
    fetchIssue: async (ref) => ({ ref, status: "To Do", statusCategory: "new" }),
    updateIssue: async (ref, u) => updates.push([ref, u.status]),
  };
}

test("startIssue with refs moves those, not the workspace's issue or its group", () =>
  withSandboxHome(async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "issue-start-ref-"));
    try {
      fs.mkdirSync(dotDir(ws), { recursive: true });
      fs.writeFileSync(
        path.join(dotDir(ws), "workspace.yml"),
        "feature: f\nissue_id: X-1\ngroup:\n  - X-2\n",
      );
      const t = tracker();
      assert.equal(await startIssue(ws, t, JIRA, ["X-9"]), "X-9 → In Progress");
      assert.deepEqual(t.updates, [["X-9", "In Progress"]]);
      // No ref: the workspace's issue and its member, as before.
      const own = tracker();
      await startIssue(ws, own, JIRA);
      assert.deepEqual(
        own.updates.map(([r]) => r),
        ["X-1", "X-2"],
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }));

test("an autonomous workspace pre-approves only the bare issue start", () => {
  for (const name of ["werkmeister", "w9r"]) {
    assert.ok(AUTONOMOUS_RULES.includes(`Bash(${name} issue start)`), name);
    assert.ok(!AUTONOMOUS_RULES.includes(`Bash(${name} issue start:*)`), `${name} :*`);
  }
});
