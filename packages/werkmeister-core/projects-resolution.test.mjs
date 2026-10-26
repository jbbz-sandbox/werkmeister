// SW-104: a lookup lands in the named project, else the project whose scope holds
// the text's ref, else the machine's tracker; status names follow the project.
// The create prompts gain a project choice only when projects exist.

import assert from "node:assert/strict";
import { test } from "node:test";
import { withSandboxHome } from "./fixtures.mjs";

const it = await import("./dist/issue_tracker.js");
const { issueStatuses } = await import("./dist/issue_status.js");
const { wizardPrompts } = await import("./dist/workspace_prompts.js");

const TWO = `overrides:
  issue_tracker: jira
  issue_statuses: { in_review: Peer Review }
  github_org: machine-org
projects:
  acme:
    tracker: { id: github, org: acme }
    issue_statuses: { in_review: "status: review" }
  werkmeister:
    tracker: { id: jira, project: SW }
`;

test("refs resolve to the project whose scope holds them, else the machine's tracker", () =>
  withSandboxHome(
    () => {
      assert.equal(it.projectFor({ text: "SW-104" })?.name, "werkmeister");
      assert.equal(it.issueTracker({ text: "SW-104" }).id, "jira");
      assert.equal(it.projectFor({ text: "Refs: acme/web#3" })?.name, "acme");
      assert.equal(it.issueTracker({ text: "acme/web#3" }).id, "github");
      // Outside every scope: the machine's tracker (jira), no project.
      assert.equal(it.projectFor({ text: "OTHER-1" }), null);
      assert.equal(it.issueTracker({ text: "OTHER-1" }).id, "jira");
      assert.equal(it.projectFor({ text: "other/web#3" }), null);
      // A named project wins over the text; its org completes a bare repo#n.
      assert.equal(it.issueTracker({ project: "acme" }).parseRef("web#3"), "acme/web#3");
      assert.equal(it.issueTracker().parseRef("web#3"), null);
      assert.equal(
        it.issueTracker({ project: "acme", text: "SW-1" }).url("acme/web#3"),
        "https://github.com/acme/web/issues/3",
      );
      // A project that isn't configured falls back to the machine's tracker.
      assert.equal(it.issueTracker({ project: "gone" }).id, "jira");
      assert.equal(it.projectOf({ project: " acme " }), "acme");
      assert.equal(it.projectOf(null), "");
    },
    { config: TWO },
  ));

test("statuses: a project's map over its tracker's defaults; no project keeps the overrides", () =>
  withSandboxHome(
    () => {
      const acme = issueStatuses({ project: "acme" });
      assert.equal(acme.in_review, "status: review");
      assert.equal(acme.in_progress, "status: in progress");
      assert.equal(acme.done, "closed");
      const sw = issueStatuses({ text: "SW-9" });
      assert.equal(sw.in_review, "In Review", "not the machine's Peer Review");
      assert.equal(issueStatuses({ text: "OTHER-1" }).in_review, "Peer Review");
      assert.equal(issueStatuses().in_review, "Peer Review");
    },
    { config: TWO },
  ));

test("projectForIssue: named, else scope, else default; refuses what doesn't fit", () =>
  withSandboxHome(
    () => {
      assert.equal(it.projectForIssue("SW-9")?.name, "werkmeister");
      assert.equal(it.projectForIssue("acme/web#3")?.name, "acme");
      assert.equal(it.projectForIssue("", "acme")?.name, "acme");
      assert.equal(it.projectForIssue(""), null);
      assert.throws(
        () => it.projectForIssue("OTHER-1"),
        /OTHER-1 isn't in any project's scope; pass --project \(one of: acme, werkmeister\)/,
      );
      assert.throws(
        () => it.projectForIssue("SW-9", "acme"),
        /SW-9 isn't a GitHub issue in project acme \(e\.g\. owner\/repo#12\)/,
      );
      assert.throws(() => it.projectForIssue("SW-9", "gone"), /no project "gone"/);
    },
    { config: TWO },
  ));

test("projectForIssue: the default project takes a ref no scope holds, if its tracker does", () =>
  withSandboxHome(
    () => {
      assert.equal(it.projectForIssue("OTHER-1")?.name, "werkmeister");
      assert.throws(() => it.projectForIssue("other/web#3"), /isn't a Jira issue in project/);
    },
    {
      config: `projects:
  acme: { tracker: { id: github, org: acme } }
  werkmeister: { tracker: { id: jira, project: SW }, default: true }
`,
    },
  ));

test("no projects: no project, the machine's tracker, and --project is refused", () =>
  withSandboxHome(
    () => {
      assert.equal(it.projectFor({ text: "SW-9" }), null);
      assert.equal(it.issueTracker({ project: "acme", text: "o/r#1" }).id, "github");
      assert.equal(it.projectForIssue("o/r#1"), null);
      assert.throws(() => it.projectForIssue("o/r#1", "acme"), /no projects: in its config/);
    },
    { config: "overrides:\n  issue_tracker: github\n" },
  ));

test("prompts: a project choice after the issue only when projects exist", async () => {
  await withSandboxHome(
    () => {
      const prompts = wizardPrompts();
      const keys = prompts.map((p) => p.key);
      assert.equal(keys.indexOf("project"), keys.indexOf("issue_id") + 1);
      const project = prompts.find((p) => p.key === "project");
      assert.deepEqual(project.choicesFn(), ["acme", "werkmeister"]);
      assert.equal(project.defaultFn(""), "", "no default: true project");
      const issue = prompts.find((p) => p.key === "issue_id");
      assert.equal(issue.pattern, undefined, "the tracker isn't known before the project");
      assert.equal(issue.placeholder, "owner/repo#12 or PROJ-123");
    },
    { config: TWO },
  );
  await withSandboxHome(
    () => {
      const prompts = wizardPrompts();
      assert.ok(!prompts.some((p) => p.key === "project"));
      const issue = prompts.find((p) => p.key === "issue_id");
      assert.equal(issue.placeholder, "owner/repo#12");
      assert.equal(issue.pattern, it.GITHUB_ISSUE_PATTERN);
    },
    { config: "overrides:\n  issue_tracker: github\n" },
  );
});
