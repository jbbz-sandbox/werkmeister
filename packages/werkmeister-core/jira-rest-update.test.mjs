// updateIssueRest: a status is matched to a transition by its target status
// (then the transition's own name), case-insensitively; a comment is posted.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.JIRA_BASE_URL = "https://x.atlassian.net";
process.env.JIRA_EMAIL = "a@b.c";
process.env.JIRA_API_TOKEN = "tok";
const { updateIssueRest } = await import("./dist/jira-rest.js");

const TRANSITIONS = {
  transitions: [
    { id: "11", name: "Start", to: { name: "In Development" } },
    { id: "21", name: "Finish", to: { name: "Done" } },
  ],
};

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(init.method === "POST" ? null : JSON.stringify(TRANSITIONS), {
      status: init.method === "POST" ? 204 : 200,
    });
  };
  return calls;
}

test("a status moves the issue through the transition that reaches it", async () => {
  const calls = stubFetch();
  assert.equal(await updateIssueRest("PROJ-1", { status: "in development" }), true);
  assert.deepEqual(calls.at(-1), {
    url: "https://x.atlassian.net/rest/api/2/issue/PROJ-1/transitions",
    method: "POST",
    body: { transition: { id: "11" } },
  });
});

test("a transition's own name matches too, and a comment is posted", async () => {
  const calls = stubFetch();
  await updateIssueRest("PROJ-1", { status: "Finish", comment: "shipped" });
  assert.deepEqual(
    calls.slice(1).map((c) => [c.url.split("/PROJ-1")[1], c.body]),
    [
      ["/transitions", { transition: { id: "21" } }],
      ["/comment", { body: "shipped" }],
    ],
  );
});

test("a status no transition reaches names the ones that exist", async () => {
  stubFetch();
  await assert.rejects(
    updateIssueRest("PROJ-1", { status: "Blocked" }),
    /no transition to "Blocked" \(available: In Development, Done\)/,
  );
});
