// `overrides.issue_tracker: github` swaps the workspace's ticket prompt, its
// CLAUDE.md link, and where the issues guide sends app-code issues: the GitHub
// issues of every repo in the services registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "issue-tracker-"));
writeFileSync(path.join(dir, "config.yaml"), "overrides:\n  issue_tracker: github\n  github_org: acme\n");
writeFileSync(path.join(dir, "services.yaml"), "services: {}\nrepos:\n  web: {}\n  api: {}\n");
process.env.SANDBOX_CONFIG_FILE = path.join(dir, "config.yaml");
process.env.SANDBOX_SERVICES_YAML = path.join(dir, "services.yaml");

const it = await import("./dist/issue_tracker.js");
const { wizardPrompts } = await import("./dist/workspace_prompts.js");
const { buildIssuesReportMd } = await import("./dist/issues_report.js");

test("github tracker spans every registry repo under the org", () => {
  assert.equal(it.loadIssueTracker(), "github");
  assert.deepEqual(it.githubIssueRepos(), ["acme/api", "acme/web"]);
});

test("refs normalize, slug, and link", () => {
  assert.equal(it.normalizeGithubIssue("api#7"), "acme/api#7");
  assert.equal(it.normalizeGithubIssue("https://github.com/o/r/issues/9"), "o/r#9");
  assert.equal(it.githubIssueSlug("acme/my_api#7"), "my-api-7");
  assert.deepEqual(it.issueLink({ GITHUB_ISSUE: "acme/api#7" }), ["acme/api#7", "https://github.com/acme/api/issues/7"]);
  assert.deepEqual(it.issueLink({ JIRA_ID: "PROJ-1" }), ["PROJ-1", null]); // no jira.base_url
});

test("the wizard asks for a GitHub issue first, not a Jira id", () => {
  const keys = wizardPrompts().map((p) => p.key);
  assert.equal(keys[0], "github_issue");
  assert.ok(!keys.includes("jira_id"));
});

test("the issues guide routes app-code issues to the registry repos", () => {
  const md = buildIssuesReportMd("ws");
  assert.match(md, /one of `acme\/api`, `acme\/web`/);
  assert.match(md, /gh issue list -R <owner>\/<repo>/);
});

test("the issues guide maps each type to a label, a Jira type and a template", () => {
  const md = buildIssuesReportMd("ws");
  assert.match(md, /^\| bug \| .* \| `--label bug` \| Bug \|$/m);
  assert.match(md, /^\| feature \| .* \| `--label enhancement` \| Story \|$/m);
  assert.match(md, /^\| task \| .*`--label task`.*`gh label create task -R <owner>\/<repo> --color ededed --force`.* \| Task \|$/m);
  assert.match(md, /- \*\*Type:\*\* bug\n/);
  assert.match(md, /- \*\*Type:\*\* feature \| task\n[\s\S]*\*\*Ask\*\*[\s\S]*\*\*Why\*\*[\s\S]*\*\*Where to change\*\*[\s\S]*\*\*Done when\*\*/);
});
