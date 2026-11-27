// SW-1014: a status move reads the issue once; only `issue view` and issue.md fetch the parent epic.

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { startFakeJira } = await import("../dist/fixture_fakes.js");
const jira = await startFakeJira();
after(() => jira.close());
process.env.JIRA_BASE_URL = jira.url;
process.env.JIRA_EMAIL = "fixture@example.invalid";
process.env.JIRA_API_TOKEN = "fixture";
const { jiraTracker } = await import("../dist/issue_trackers/jira.js");
const { moveIssue } = await import("../dist/issue_status.js");
const { fetchIssueSnapshot } = await import("../dist/issue_snapshot.js");

test("a status move on a child makes no GET of its parent epic", async () => {
  const line = await moveIssue(
    jiraTracker(),
    "SW-595",
    "in_progress",
    { in_progress: "In Progress" },
    { comment: "started" },
  );
  assert.match(line, /SW-595/);
  assert.ok(jira.calls.includes("GET /rest/api/2/issue/SW-595"), jira.calls.join("\n"));
  assert.ok(!jira.calls.includes("GET /rest/api/2/issue/SW-585"), jira.calls.join("\n"));
});

test("the issue.md snapshot still reads the parent", async () => {
  const snap = await fetchIssueSnapshot("SW-595", undefined, jiraTracker());
  assert.ok(jira.calls.includes("GET /rest/api/2/issue/SW-585"));
  assert.match(JSON.stringify(snap), /review doc/);
});
