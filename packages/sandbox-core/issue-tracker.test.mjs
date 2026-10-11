// `overrides.issue_tracker: github` swaps the workspace's ticket prompt, its
// CLAUDE.md link, and where the issues guide sends app-code issues: the GitHub
// issues of every repo in the services registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

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
  const gh = it.issueTracker();
  assert.equal(gh.id, "github");
  assert.equal(gh.slug("acme/my_api#7"), "my-api-7");
  assert.equal(gh.parseRef("api#7"), "acme/api#7");
  assert.equal(gh.parseRef("Refs: acme/api#12 and more"), "acme/api#12");
  assert.equal(gh.parseRef("jayboyer/proj-12-thing"), null);
  assert.deepEqual(it.issueLink({ ISSUE_ID: "acme/api#7" }), ["acme/api#7", "https://github.com/acme/api/issues/7"]);
  // Pre-rename .env keys still link.
  assert.deepEqual(it.issueLink({ GITHUB_ISSUE: "acme/api#7" }), ["acme/api#7", "https://github.com/acme/api/issues/7"]);
  const jira = it.trackerById("jira");
  assert.equal(jira.parseRef("https://x.atlassian.net/browse/proj-12?x=1"), "PROJ-12");
  assert.equal(jira.parseRef("jayboyer/proj-12-thing"), "PROJ-12");
  assert.equal(jira.url("PROJ-1"), null); // no jira.base_url
});

test("workspace.yml issue refs: issue_id, else the pre-rename keys", () => {
  assert.equal(it.issueIdOf({ issue_id: "acme/api#1", jira_id: "PROJ-1" }), "acme/api#1");
  assert.equal(it.issueIdOf({ jira_id: "PROJ-1" }), "PROJ-1");
  assert.equal(it.issueIdOf({ github_issue: "acme/api#2" }), "acme/api#2");
  assert.equal(it.issueIdOf(null), "");
});

test("the wizard's issue prompt takes the tracker's wording and pattern", () => {
  const p = wizardPrompts();
  assert.equal(p[0].key, "issue_id");
  assert.match(p[0].label, /^GitHub issue/);
  assert.equal(p[0].pattern, it.GITHUB_ISSUE_PATTERN);
  assert.ok(!p.some((x) => x.key === "jira_id" || x.key === "github_issue"));
});

test("a briefing carries title, meta, description and the non-blank comments", () => {
  const b = it.issueBriefing({
    ref: "PROJ-1",
    title: "Do the thing",
    status: "In Progress",
    type: "Story",
    assignee: "Jay",
    description: "Long body",
    comments: [{ author: "A", created: "2026-07-01T00:00:00Z", body: "first" }, { author: "unknown", body: "no date" }],
  });
  assert.match(b, /^PROJ-1: Do the thing/);
  assert.match(b, /Status: In Progress · Type: Story · Assignee: Jay/);
  assert.match(b, /Description:\nLong body/);
  assert.match(b, /- \[A 2026-07-01\] first/);
  assert.match(b, /- \[unknown\] no date/);
  assert.equal(it.issueBriefing({ ref: "PROJ-2" }), "PROJ-2: (no title)");
});

test("the issues guide routes app-code issues to the registry repos", () => {
  const md = buildIssuesReportMd("ws");
  assert.match(md, /one of `acme\/api`, `acme\/web`/);
  assert.match(md, /gh issue list -R <owner>\/<repo>/);
});

test("the issues guide maps each type to a label, the tracker's type and a template", () => {
  const md = buildIssuesReportMd("ws", "", it.trackerById("jira"));
  assert.match(md, /^\| bug \| .* \| `--label bug` \| Bug \|$/m);
  assert.match(md, /^\| feature \| .* \| `--label enhancement` \| Story \|$/m);
  assert.match(md, /^\| task \| .*`--label task`.*`gh label create task -R <owner>\/<repo> --color ededed --force`.* \| Task \|$/m);
  assert.match(md, /- \*\*Type:\*\* bug\n/);
  assert.match(md, /- \*\*Type:\*\* feature \| task\n[\s\S]*\*\*Ask\*\*[\s\S]*\*\*Why\*\*[\s\S]*\*\*Where to change\*\*[\s\S]*\*\*Done when\*\*/);
});

test("github checkAuth: signed in, signed out, no repo access", async () => {
  await withSandboxHome(async () => {
    const t = it.issueTracker();
    await withFakeGh({ auth: 0 }, async () => assert.deepEqual(await t.checkAuth(), { ok: true, who: "octo", fix: "" }));
    await withFakeGh({ auth: 1 }, async () => assert.deepEqual(await t.checkAuth(), { ok: false, reason: "not signed in", fix: "gh auth login" }));
  }, { config: "overrides:\n  issue_tracker: github\n" });
  await withSandboxHome(async () => {
    const t = it.issueTracker();
    await withFakeGh({ auth: 0, repoView: 1 }, async () =>
      assert.deepEqual(await t.checkAuth(), { ok: false, who: "octo", reason: "can't read acme/api", fix: "gh auth refresh -s repo" }));
  }, { config: "overrides:\n  issue_tracker: github\n  github_org: acme\n" });
});

test("jira with no REST creds: ok, via the Atlassian MCP fallback", async () => {
  const saved = Object.fromEntries(["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    await withSandboxHome(async () => {
      assert.deepEqual(await it.issueTracker().checkAuth(), { ok: true, who: "via Atlassian MCP (not checked)", fix: "" });
    }, { config: "overrides:\n  issue_tracker: jira\n" });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("jira placeholder base_url counts as not configured (#114)", async () => {
  const saved = Object.fromEntries(["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    await withSandboxHome(async () => {
      const t = it.issueTracker();
      assert.equal(t.url("PROJ-1"), null);
      const a = await t.checkAuth();
      assert.equal(a.ok, false);
      assert.match(a.fix, /jira-rest-setup\.md/);
    }, { config: "overrides:\n  issue_tracker: jira\njira:\n  base_url: https://your-org.atlassian.net\n  email: a@b.c\n  api_token: x\n" });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});
