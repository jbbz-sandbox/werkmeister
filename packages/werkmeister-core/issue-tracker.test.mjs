// `overrides.issue_tracker: github` swaps the workspace's ticket prompt, its
// CLAUDE.md link, and where the issues guide sends app-code issues: the GitHub
// issues of every repo in the services registry.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withFakeGh, withSandboxHome } from "./fixtures.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "issue-tracker-"));
writeFileSync(
  path.join(dir, "config.yaml"),
  "overrides:\n  issue_tracker: github\n  github_org: acme\n",
);
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
  assert.deepEqual(it.issueLink({ ISSUE_ID: "acme/api#7" }), [
    "acme/api#7",
    "https://github.com/acme/api/issues/7",
  ]);
  // Pre-rename .env keys still link.
  assert.deepEqual(it.issueLink({ GITHUB_ISSUE: "acme/api#7" }), [
    "acme/api#7",
    "https://github.com/acme/api/issues/7",
  ]);
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

// The label stays "Issue" on every tracker (docs/ui-spec.md); the example names the format.
test("the wizard's issue prompt takes the tracker's example and pattern", () => {
  const p = wizardPrompts();
  assert.equal(p[0].key, "issue_id");
  assert.equal(p[0].label, "Issue");
  assert.equal(p[0].placeholder, it.issueTracker().refExample);
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
    comments: [
      { author: "A", created: "2026-07-01T00:00:00Z", body: "first" },
      { author: "unknown", body: "no date" },
    ],
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
  assert.match(
    md,
    /^\| task \| .*`--label task`.*`gh label create task -R <owner>\/<repo> --color ededed --force`.* \| Task \|$/m,
  );
  assert.match(md, /- \*\*Type:\*\* bug\n/);
  assert.match(
    md,
    /- \*\*Type:\*\* feature \| task\n[\s\S]*\*\*Ask\*\*[\s\S]*\*\*Why\*\*[\s\S]*\*\*Where to change\*\*[\s\S]*\*\*Done when\*\*/,
  );
});

test("by default sandbox-tool issues go to GitHub, with labels, whatever the tracker", () => {
  for (const t of [it.trackerById("github"), it.trackerById("jira")]) {
    const md = buildIssuesReportMd("ws", "PROJ-1", t);
    assert.match(
      md,
      /^\| the `sandbox` tool: .* \| `gh issue create -R jbbz-sandbox\/werkmeister --label <label>` \|$/m,
    );
    assert.match(md, /\| GitHub label \|/);
  }
});

test("sandbox_issues_project sends sandbox-tool issues to that Jira project", async () => {
  await withSandboxHome(
    async () => {
      const md = buildIssuesReportMd("ws", "PROJ-1");
      assert.match(
        md,
        /^\| the `sandbox` tool: .* \| Jira, project `SW` \(https:\/\/x\.atlassian\.net\) \| `sandbox issue create --project SW --type <type> --title "<title>" --body-file <file>`; .* \|$/m,
      );
      assert.match(
        md,
        /^\| app code in a worktree \| Jira, project `PROJ` .* `sandbox issue create --project PROJ /m,
      );
      assert.match(
        md,
        /JQL `project = PROJ AND text ~ "<keywords>"`.*\(Sandbox-tool issues: JQL `project = SW AND /,
      );
      assert.doesNotMatch(md, /gh issue|GitHub label/);
      assert.match(md, /^\| bug \| something that is broken \| Bug \|$/m);
    },
    {
      config:
        "overrides:\n  issue_tracker: jira\n  sandbox_issues_project: sw\njira:\n  base_url: https://x.atlassian.net\n",
    },
  );
});

test("github checkAuth: signed in, signed out, no repo access", async () => {
  await withSandboxHome(
    async () => {
      const t = it.issueTracker();
      await withFakeGh({ auth: 0 }, async () =>
        assert.deepEqual(await t.checkAuth(), { ok: true, who: "octo", fix: "" }),
      );
      await withFakeGh({ auth: 1 }, async () =>
        assert.deepEqual(await t.checkAuth(), {
          ok: false,
          reason: "not signed in",
          fix: "gh auth login",
        }),
      );
    },
    { config: "overrides:\n  issue_tracker: github\n" },
  );
  await withSandboxHome(
    async () => {
      const t = it.issueTracker();
      await withFakeGh({ auth: 0, repoView: 1 }, async () =>
        assert.deepEqual(await t.checkAuth(), {
          ok: false,
          who: "octo",
          reason: "can't read acme/api",
          fix: "gh auth refresh -s repo",
        }),
      );
    },
    { config: "overrides:\n  issue_tracker: github\n  github_org: acme\n" },
  );
});

test("github updateIssue: a status label is created when the repo lacks it, then added (#156)", async () => {
  const t = it.issueTracker();
  for (const labels of [[], ["In Development"]]) {
    await withFakeGh({ labels }, async (bin) => {
      await t.updateIssue("acme/api#12", { status: "In Development" });
      await t.updateIssue("acme/api#12", { status: "In Development" });
      const calls = readFileSync(path.join(path.dirname(bin), "calls"), "utf8")
        .trim()
        .split("\n");
      assert.deepEqual(calls.slice(0, 2), [
        "label create In Development -R acme/api --color 1D76DB --force",
        "issue edit 12 -R acme/api --add-label In Development",
      ]);
    });
  }
});

test("github updateIssue: a status: label replaces the other status: labels and is created if missing (SW-27)", async () => {
  const t = it.issueTracker();
  const issue = {
    labels: [{ name: "bug" }, { name: "status: in progress" }, { name: "Status: Blocked" }],
  };
  await withFakeGh({ issue, labels: ["bug", "status: in progress"] }, async (bin) => {
    await t.updateIssue("acme/api#12", { status: "status: in review" });
    const calls = readFileSync(path.join(path.dirname(bin), "calls"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(calls, [
      "issue view 12 -R acme/api --json labels",
      "label create status: in review -R acme/api --color 1D76DB --force",
      "issue edit 12 -R acme/api --add-label status: in review --remove-label status: in progress,Status: Blocked",
    ]);
  });
});

test("github updateIssue: done closes as completed, not planned closes as not planned", async () => {
  const t = it.issueTracker();
  await withFakeGh({}, async (bin) => {
    await t.updateIssue("acme/api#12", { status: "closed", comment: "Shipped: v1 — u" });
    await t.updateIssue("acme/api#12", { status: "not planned" });
    const calls = readFileSync(path.join(path.dirname(bin), "calls"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(calls, [
      "issue close 12 -R acme/api --reason completed",
      "issue comment 12 -R acme/api --body Shipped: v1 — u",
      "issue close 12 -R acme/api --reason not planned",
    ]);
  });
});

test("github fetchIssue: labels, and closed reads as the done category", async () => {
  const t = it.issueTracker();
  await withFakeGh(
    { issue: { title: "t", state: "CLOSED", labels: [{ name: "status: in review" }] } },
    async () => {
      const i = await t.fetchIssue("acme/api#12");
      assert.equal(i.statusCategory, "done");
      assert.deepEqual(i.labels, ["status: in review"]);
    },
  );
});

test("jira with no REST creds: ok, via the Atlassian MCP fallback", async () => {
  const saved = Object.fromEntries(
    ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].map((k) => [k, process.env[k]]),
  );
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    await withSandboxHome(
      async () => {
        assert.deepEqual(await it.issueTracker().checkAuth(), {
          ok: true,
          who: "via Atlassian MCP (not checked)",
          fix: "",
        });
      },
      { config: "overrides:\n  issue_tracker: jira\n" },
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("jira placeholder base_url counts as not configured (#114)", async () => {
  const saved = Object.fromEntries(
    ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"].map((k) => [k, process.env[k]]),
  );
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    await withSandboxHome(
      async () => {
        const t = it.issueTracker();
        assert.equal(t.url("PROJ-1"), null);
        const a = await t.checkAuth();
        assert.equal(a.ok, false);
        assert.match(a.fix, /jira-rest-setup\.md/);
      },
      {
        config:
          "overrides:\n  issue_tracker: jira\njira:\n  base_url: https://your-org.atlassian.net\n  email: a@b.c\n  api_token: x\n",
      },
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});
