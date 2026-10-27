// fetchIssueRest stays null on failure, and names the failure for a caller that asks (SW-109).

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.JIRA_BASE_URL = "https://x.atlassian.net";
process.env.JIRA_EMAIL = "a@b.c";
process.env.JIRA_API_TOKEN = "tok";
const { fetchIssueRest } = await import("./dist/jira-rest.js");

test("an HTTP failure is null, with the status and Jira's message in why", async () => {
  globalThis.fetch = async () =>
    new Response('{"errorMessages":["Service Unavailable"]}', { status: 503 });
  const why = [];
  assert.equal(await fetchIssueRest("PROJ-1", why), null);
  assert.equal(why.length, 1);
  assert.match(why[0], /HTTP 503: \{"errorMessages":\["Service Unavailable"\]\}/);
});

test("a network failure names its cause code", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
    });
  };
  const why = [];
  assert.equal(await fetchIssueRest("PROJ-1", why), null);
  assert.deepEqual(why, ["Jira REST: fetch failed (ECONNRESET)"]);
});
