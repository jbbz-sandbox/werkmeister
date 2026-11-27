// SW-1015: a parent epic that can't be read keeps the child, and the parent's key and summary, against the fake Jira.

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { startFakeJira } = await import("../dist/fixture_fakes.js");
const jira = await startFakeJira();
after(() => jira.close());
process.env.JIRA_BASE_URL = jira.url;
process.env.JIRA_EMAIL = "fixture@example.invalid";
process.env.JIRA_API_TOKEN = "fixture";
const { jiraTracker } = await import("../dist/issue_trackers/jira.js");

test("a failed parent GET keeps the child with parent.ref and parent.title, no description", async () => {
  const issue = await jiraTracker().fetchIssue("SW-596", undefined, { withParent: true });
  assert.equal(issue.ref, "SW-596");
  assert.equal(issue.title, "Docs: a story whose epic is gone");
  assert.equal(issue.parent.ref, "SW-586");
  assert.equal(issue.parent.title, "Deleted epic");
  assert.equal(issue.parent.description, undefined);
  assert.ok(jira.calls.includes("GET /rest/api/2/issue/SW-586"), "the parent GET was tried");
});
