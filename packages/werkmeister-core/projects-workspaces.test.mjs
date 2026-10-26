// SW-104 acceptance: one machine, a Jira project and a GitHub project. Each
// workspace's issue link and status moves go to its own project's tracker; a
// workspace with no project, or a machine with no projects, works as before.
// Jira is a stubbed fetch, GitHub a fake gh: nothing leaves the machine.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { dotDir } from "./dist/config.js";
import { startIssue } from "./dist/issue_status.js";
import { resolveIssueCopy } from "./dist/workspace_init.js";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

// Credentials come from the temp config's jira: block, never the developer's shell.
for (const k of ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]) delete process.env[k];

const JIRA = `jira:
  base_url: https://x.atlassian.net
  email: a@b.c
  api_token: tok
`;
const TWO = `${JIRA}projects:
  acme:
    tracker: { id: github, org: acme }
  werkmeister:
    tracker: { id: jira, project: SW }
`;
const GH_ISSUE = {
  title: "T",
  state: "OPEN",
  body: "b",
  url: "https://github.com/acme/web/issues/3",
  labels: [],
  assignees: [],
  comments: [],
};

function workspace(yml) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "proj-ws-"));
  fs.mkdirSync(path.join(ws, "stages", "01_research", "output"), { recursive: true });
  fs.mkdirSync(dotDir(ws), { recursive: true });
  fs.writeFileSync(path.join(dotDir(ws), "workspace.yml"), `feature: f\n${yml}`);
  return ws;
}

/** Jira REST stub: issue *key* sits at To Do with a transition to In Progress; records each call. */
function stubJira() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(`${init.method ?? "GET"} ${u.replace("https://x.atlassian.net", "")}`);
    if (init.method === "POST") return new Response(null, { status: 204 });
    if (u.includes("/transitions"))
      return Response.json({
        transitions: [{ id: "11", name: "Start", to: { name: "In Progress" } }],
      });
    return Response.json({
      key: "SW-9",
      fields: { summary: "s", status: { name: "To Do", statusCategory: { key: "new" } } },
    });
  };
  return calls;
}

const ghCalls = (bin) => {
  const f = path.join(path.dirname(bin), "calls");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n") : [];
};

test("two projects: each workspace's link and start move go to its own tracker", () =>
  withSandboxHome(
    () =>
      withFakeGh({ issue: GH_ISSUE }, async (bin) => {
        const jiraWs = workspace("issue_id: SW-9\nproject: werkmeister\n");
        const ghWs = workspace("issue_id: acme/web#3\nproject: acme\n");
        try {
          assert.equal(
            (await resolveIssueCopy(jiraWs, "SW-9", { project: "werkmeister" })).url,
            "https://x.atlassian.net/browse/SW-9",
          );
          assert.equal(
            (await resolveIssueCopy(ghWs, "acme/web#3", { project: "acme" })).url,
            "https://github.com/acme/web/issues/3",
          );

          const jira = stubJira();
          assert.equal(await startIssue(jiraWs), "SW-9 → In Progress");
          assert.ok(jira.includes("POST /rest/api/2/issue/SW-9/transitions"), jira.join("\n"));
          assert.deepEqual(ghCalls(bin), [], "the Jira workspace never calls gh");

          const jiraAfter = stubJira();
          assert.equal(await startIssue(ghWs), "acme/web#3 → status: in progress");
          assert.deepEqual(jiraAfter, [], "the GitHub workspace never calls Jira");
          assert.ok(
            ghCalls(bin).includes("issue edit 3 -R acme/web --add-label status: in progress"),
            ghCalls(bin).join("\n"),
          );
        } finally {
          for (const ws of [jiraWs, ghWs]) fs.rmSync(ws, { recursive: true, force: true });
        }
      }),
    { config: TWO },
  ));

test("a workspace with no project uses the machine's tracker, projects or not", async () => {
  for (const config of [TWO, JIRA]) {
    await withSandboxHome(
      () =>
        withFakeGh({ issue: GH_ISSUE }, async (bin) => {
          const ws = workspace("issue_id: OTHER-9\n");
          try {
            assert.equal(
              (await resolveIssueCopy(ws, "OTHER-9", {})).url,
              "https://x.atlassian.net/browse/OTHER-9",
            );
            const jira = stubJira();
            assert.equal(await startIssue(ws), "OTHER-9 → In Progress");
            assert.ok(jira.includes("POST /rest/api/2/issue/OTHER-9/transitions"));
            assert.deepEqual(ghCalls(bin), []);
          } finally {
            fs.rmSync(ws, { recursive: true, force: true });
          }
        }),
      { config },
    );
  }
});
