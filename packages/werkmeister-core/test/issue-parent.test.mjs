// A Jira issue's parent epic reaches `issue view` and issue.md (SW-633), against the fake Jira.

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { startFakeJira } = await import("../dist/fixture_fakes.js");
const jira = await startFakeJira();
after(() => jira.close());
process.env.JIRA_BASE_URL = jira.url;
process.env.JIRA_EMAIL = "fixture@example.invalid";
process.env.JIRA_API_TOKEN = "fixture";
const { jiraTracker } = await import("../dist/issue_trackers/jira.js");
const { issueBriefing } = await import("../dist/issue_tracker.js");
const { fetchIssueSnapshot, renderIssueCopy } = await import("../dist/issue_snapshot.js");

test("fetchIssue reads the parent, then the parent's description", async () => {
  const issue = await jiraTracker().fetchIssue("SW-595");
  assert.equal(issue.parent.ref, "SW-585");
  assert.equal(issue.parent.title, "Werkmeister docs overhaul");
  assert.match(issue.parent.description, /\[review doc\]\(https:\/\/example\.invalid\/review\)/);
  assert.ok(jira.calls.includes("GET /rest/api/2/issue/SW-585"));
  const view = issueBriefing(issue, { full: true });
  assert.match(view, /\nParent: SW-585 Werkmeister docs overhaul\n/);
  assert.match(view, /Parent description:\n[\s\S]*https:\/\/example\.invalid\/review/);
});

test("no parent: no Parent line, no second fetch", async () => {
  const before = jira.calls.length;
  const issue = await jiraTracker().fetchIssue("SW-2");
  assert.equal(issue.parent, undefined);
  assert.equal(jira.calls.length, before + 1);
  assert.doesNotMatch(issueBriefing(issue, { full: true }), /Parent/);
});

test("issue.md carries the parent section", async () => {
  const text = renderIssueCopy(await fetchIssueSnapshot("SW-595", undefined, jiraTracker()));
  assert.match(
    text,
    /\n\n## Parent\n\nParent: SW-585 Werkmeister docs overhaul\n.*\n\nFindings are cited[\s\S]*https:\/\/example\.invalid\/review[\s\S]*\n\n## Comments\n/,
  );
});
