// SW-104 acceptance: a project with a board lists that board's ready items in
// board order; without a board, the scope's open issues. Jira is a stubbed
// fetch, GitHub a fake gh: nothing leaves the machine.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { githubTracker } from "./dist/issue_trackers/github.js";
import { jiraTracker } from "./dist/issue_trackers/jira.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

// Credentials come from the temp config's jira: block, never the developer's shell.
for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];

const JIRA = `jira:
  base_url: https://x.atlassian.net
  email: a@b.c
  api_token: tok
`;

const issue = (key, status) => ({ key, fields: { summary: `t ${key}`, status: { name: status } } });

/** Jira REST stub: a board with To Do / Ready / Done, issues in a non-alphabetical rank; records each URL. */
function stubJira() {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url).replace("https://x.atlassian.net", ""));
    calls.push(u);
    if (u.includes("/configuration"))
      return Response.json({
        columnConfig: {
          columns: [
            { name: "To Do", statuses: [{ id: "1" }] },
            { name: "Ready", statuses: [{ id: "10" }, { id: "11" }] },
            { name: "Done", statuses: [{ id: "3" }] },
          ],
        },
      });
    return Response.json({
      issues: [issue("SW-7", "Ready"), issue("SW-2", "Ready"), issue("SW-5", "Selected")],
    });
  };
  return calls;
}

const ghCalls = (bin) => {
  const f = path.join(path.dirname(bin), "calls");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : [];
};

test("Jira board: the ready column's issues in board rank", () =>
  withSandboxHome(
    async () => {
      const calls = stubJira();
      const ready = await jiraTracker({ project: "SW" }).listReady({ id: "42", ready: "ready" });
      assert.deepEqual(
        ready.map((i) => i.ref),
        ["SW-7", "SW-2", "SW-5"],
      );
      assert.equal(ready[0].url, "https://x.atlassian.net/browse/SW-7");
      assert.equal(calls[0], "/rest/agile/1.0/board/42/configuration");
      assert.ok(
        calls[1].startsWith("/rest/agile/1.0/board/42/issue?jql=status in (10,11)&"),
        calls[1],
      );
    },
    { config: JIRA },
  ));

test("Jira board without the ready column: the error names its columns", () =>
  withSandboxHome(
    async () => {
      stubJira();
      await assert.rejects(
        jiraTracker({ project: "SW" }).listReady({ id: "42", ready: "Next" }),
        /board 42 has no "Next" column \(it has: To Do, Ready, Done\)/,
      );
    },
    { config: JIRA },
  ));

test("Jira, no board: next-wave's JQL over the project", () =>
  withSandboxHome(
    async () => {
      const calls = stubJira();
      await jiraTracker({ project: "SW" }).listReady();
      assert.ok(
        calls[0].startsWith(
          "/rest/api/2/search/jql?jql=project = SW AND statusCategory != Done ORDER BY priority DESC, rank ASC&",
        ),
        calls[0],
      );
    },
    { config: JIRA },
  ));

test("Jira without REST credentials: listing ready work says what to set", () =>
  withSandboxHome(async () => {
    await assert.rejects(jiraTracker({ project: "SW" }).listReady(), /needs Jira REST credentials/);
  }));

const item = (number, status, type = "Issue") => ({
  status,
  content: {
    type,
    number,
    repository: "acme/web",
    title: `t ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
  },
});

test("GitHub board: only Ready issues, in the order the board returns", () =>
  withSandboxHome(() =>
    withFakeGh(
      {
        items: [
          item(9, "Ready"),
          item(4, "In progress"),
          item(2, "Ready"),
          item(5, "Ready", "PullRequest"),
        ],
      },
      async (bin) => {
        const ready = await githubTracker({ org: "acme" }).listReady({ id: "3", ready: "ready" });
        assert.deepEqual(
          ready.map((i) => i.ref),
          ["acme/web#9", "acme/web#2"],
        );
        assert.deepEqual(ghCalls(bin), [
          'project item-list 3 --owner acme --format json --limit 200 --query status:"ready"',
        ]);
      },
    ),
  ));

test("GitHub, no board: open issues of each scoped repo, sorted by repo", () =>
  withSandboxHome(() =>
    withFakeGh({ issues: [{ number: 1, title: "a", url: "u", labels: [] }] }, async (bin) => {
      const ready = await githubTracker({
        org: "acme",
        repos: ["acme/web", "acme/api"],
      }).listReady();
      assert.deepEqual(
        ready.map((i) => i.ref),
        ["acme/api#1", "acme/web#1"],
      );
      assert.deepEqual(
        ghCalls(bin).map((c) => c.split(" ").slice(0, 4).join(" ")),
        ["issue list -R acme/api", "issue list -R acme/web"],
      );
    }),
  ));
