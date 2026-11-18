// Jira REST v2 returns description and comment bodies as wiki markup; a fetched
// issue holds Markdown, so .werkmeister/issue.md and `issue view` read cleanly (SW-878).

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.JIRA_BASE_URL = "https://x.atlassian.net";
process.env.JIRA_EMAIL = "a@b.c";
process.env.JIRA_API_TOKEN = "tok";
const { jiraTracker } = await import("../dist/issue_trackers/jira.js");

const WIKI =
  "h2. Why\n\n" +
  "* *Type:* bug\n" +
  "** nested {{packages/werkmeister\\-core/src}}\n" +
  "# first\n\n" +
  "Shows {{{{docker.smoke.mjs}}}} and {{\\{code\\}}} as code.\n" +
  "*Ran* {{sw\\-573\\-gate}} see [https://x.atlassian.net/browse/SW-680|https://x.atlassian.net/browse/SW-680|smart-link] " +
  "and [the docs|https://d.example/a].\n\n" +
  "{code:bash}\nfoo --bar {x}\n{code}";

const MD =
  "## Why\n\n" +
  "- **Type:** bug\n" +
  "  - nested `packages/werkmeister-core/src`\n" +
  "1. first\n\n" +
  "Shows `{{docker.smoke.mjs}}` and `{code}` as code.\n" +
  "**Ran** `sw-573-gate` see [SW-680](https://x.atlassian.net/browse/SW-680) " +
  "and [the docs](https://d.example/a).\n\n" +
  "```\nfoo --bar {x}\n```";

test("fetchIssue turns the wiki-markup description and comments into Markdown", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        key: "SW-1",
        fields: {
          summary: "t",
          status: { name: "To Do", statusCategory: { key: "new" } },
          description: WIKI,
          comment: { comments: [{ author: { displayName: "J" }, created: "c", body: WIKI }] },
        },
      }),
      { status: 200 },
    );
  const issue = await jiraTracker().fetchIssue("SW-1");
  assert.equal(issue.description, MD);
  assert.equal(issue.comments[0].body, MD);
});
