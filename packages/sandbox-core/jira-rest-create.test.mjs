// createIssueRest: files in the project with the mapped issue type, or as a
// Task labelled with the guide's type when the project lacks it (SW has no
// Bug); a refusal carries Jira's own reason. No real Jira: fetch is stubbed.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.JIRA_BASE_URL = "https://x.atlassian.net";
process.env.JIRA_EMAIL = "a@b.c";
process.env.JIRA_API_TOKEN = "tok";
const { createIssueRest } = await import("./dist/jira-rest.js");
const { trackerById } = await import("./dist/issue_tracker.js");

function stubFetch(types, createStatus = 201) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method !== "POST")
      return new Response(JSON.stringify({ issueTypes: types.map((name) => ({ name })) }));
    return createStatus === 201
      ? new Response(JSON.stringify({ key: "SW-13" }), { status: 201 })
      : new Response('{"errors":{"summary":"required"}}', { status: createStatus });
  };
  return calls;
}

const NEW = { project: "SW", fallbackLabel: "bug", summary: "t", description: "d" };

test("the mapped type is used when the project has it", async () => {
  const calls = stubFetch(["Bug", "Task"]);
  assert.deepEqual(await createIssueRest({ ...NEW, issueType: "Bug" }), {
    key: "SW-13",
    url: "https://x.atlassian.net/browse/SW-13",
    issueType: "Bug",
  });
  assert.equal(calls[0].url, "https://x.atlassian.net/rest/api/2/issue/createmeta/SW/issuetypes");
  assert.deepEqual(calls[1], {
    url: "https://x.atlassian.net/rest/api/2/issue",
    body: {
      fields: {
        project: { key: "SW" },
        issuetype: { name: "Bug" },
        summary: "t",
        description: "d",
      },
    },
  });
});

test("a type the project lacks becomes a Task labelled with the guide's type", async () => {
  const calls = stubFetch(["Epic", "Subtask", "Task", "Story"]);
  assert.equal((await createIssueRest({ ...NEW, issueType: "Bug" })).issueType, "Task");
  assert.deepEqual(calls[1].body.fields.issuetype, { name: "Task" });
  assert.deepEqual(calls[1].body.fields.labels, ["bug"]);
});

test("a refusal carries Jira's reason", async () => {
  stubFetch(["Task"], 400);
  await assert.rejects(
    createIssueRest({ ...NEW, issueType: "Task" }),
    /HTTP 400: \{"errors":\{"summary":"required"\}\}/,
  );
});

test("the jira tracker maps feature to Story and returns the issue's URL", async () => {
  const calls = stubFetch(["Story", "Task"]);
  const issue = await trackerById("jira").createIssue({
    project: "SW",
    type: "feature",
    title: "Add X",
    body: "why",
  });
  assert.deepEqual(issue, {
    ref: "SW-13",
    title: "Add X",
    type: "Story",
    url: "https://x.atlassian.net/browse/SW-13",
  });
  assert.equal(calls[1].body.fields.summary, "Add X");
});
