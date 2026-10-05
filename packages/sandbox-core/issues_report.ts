/**
 * The issue-filing guide both context strategies write into a workspace: what
 * type an issue is (bug | feature | task), where it goes — a bug is fixed here
 * if this workspace's changes caused it, otherwise it is filed on the sandbox
 * repo or in the machine's issue tracker (`overrides.issue_tracker`: the Jira
 * project, or the GitHub issues of the registry repo it belongs to) — and the
 * body per type. icm writes it to `_shared/issues-report.md`, jit to
 * `.sandbox/issues-report.md`; each strategy's CLAUDE.md points at its copy.
 */

import { loadJira } from "./global_config.js";
import { githubIssueRepos, loadIssueTracker, type IssueTracker } from "./issue_tracker.js";

export const SANDBOX_ISSUES_REPO = "jbbz-sandbox/sandbox";

/** The app-code row of the "Where" table and the search step, per tracker. */
function appCodeRouting(tracker: IssueTracker, jiraId: string, repos: string[]): [string, string] {
  if (tracker === "github") {
    const where = repos.length
      ? `the GitHub issues of the repo it belongs to — one of ${repos.map((r) => `\`${r}\``).join(", ")}`
      : "that repo's GitHub issues — find it with \`git -C <worktree> remote get-url origin\`";
    return [
      `| app code in a worktree | ${where} | \`gh issue create -R <owner>/<repo> --label <label>\` |`,
      'Search first: `gh issue list -R <owner>/<repo> --search "<keywords>" --state all`. If it exists, comment on it instead.',
    ];
  }
  const project = /^([A-Z][A-Z0-9]+)-\d+$/.exec(jiraId)?.[1];
  const base = (loadJira().base_url ?? "").trim().replace(/\/+$/, "");
  const where = `Jira${project ? `, project \`${project}\`` : " — ask the person which project"}${base ? ` (${base})` : ""}`;
  return [
    `| app code in a worktree | ${where} | the Atlassian MCP tools if connected, with the Jira issue type from the type table; otherwise hand the person the title, type and body to file |`,
    `Search first: JQL \`${project ? `project = ${project} AND ` : ""}text ~ "<keywords>"\`. If it exists, comment on it instead. (Sandbox-tool issues: \`gh issue list -R ${SANDBOX_ISSUES_REPO} --search "<keywords>" --state all\`.)`,
  ];
}

export function buildIssuesReportMd(
  workspaceName: string,
  jiraId = "",
  tracker: IssueTracker = loadIssueTracker(),
  repos: string[] = tracker === "github" ? githubIssueRepos() : [],
): string {
  const [appRow, searchStep] = appCodeRouting(tracker, jiraId.trim(), repos);
  return `# Filing an issue

Log an issue when you find it, even if the notes are rough. Each issue must stand alone: a later agent should be able to act on it without re-running this workspace or asking follow-up questions.

## Type

Every issue has one type. It sets the label (GitHub) or issue type (Jira) and the body template.

| Type | Use for | GitHub label | Jira issue type |
|---|---|---|---|
| bug | something that is broken | \`--label bug\` | Bug |
| feature | new or changed behavior | \`--label enhancement\` | Story |
| task | setup, cleanup, chores — no behavior change | \`--label task\` (not a GitHub default: run \`gh label create task -R <owner>/<repo> --color ededed --force\` first) | Task |

## Bugs: new or existing?

Decide this first.

- **New — this workspace's changes caused it** (the bug is in code changed on this branch, committed or not, and does not happen on the base branch): fix it here, in the current stage or phase. Do **not** file an issue.
- **Existing — it was already there** (it happens on the base branch, or it is in code this workspace has not touched, including the \`sandbox\` tool itself): file it as an issue where it belongs (table below), then carry on. Fix it here only if the current task depends on it, and say so in the issue.

Not sure? Check whether it happens on the base branch. If you still can't tell, ask the person — don't guess.

## Features and tasks

File one when the person asks for it, or when you find work outside this workspace's task. Work inside the task is done here, not filed.

## Where

| Issue is about | File at | Command |
|---|---|---|
| the \`sandbox\` tool: CLI, MCP tools, plugin skills, generated files (\`.sandbox/\`, \`docker-compose.yml\`, \`.env\`, \`CLAUDE.md\`, context files), containers, ports, Caddy routing, workspace init/teardown | https://github.com/${SANDBOX_ISSUES_REPO}/issues | \`gh issue create -R ${SANDBOX_ISSUES_REPO} --label <label>\` |
${appRow}

## How

1. ${searchStep}
2. Title: one-line summary. Label or issue type: from the type table. Body: the template for its type (with \`gh\`, via \`--body-file\`).
3. Paste exact commands and error output — don't paraphrase.
4. Tell the person the issue URL, then resume what you were doing.

## Body template: bug

~~~markdown
- **Type:** bug
- **Workspace:** ${workspaceName} (stage or phase you were in)
- **Severity:** blocker | major | minor | papercut
- **Area:** <e.g. CLI | MCP tool | plugin skill | generated files | containers | routing/Caddy | ports | docs | app code>
- **Status:** open | worked-around

**Ran**
\`\`\`sh
<exact command, MCP tool call, or skill invoked>
\`\`\`

**Expected**
<what should have happened>

**Actual**
<what happened>

**Evidence**
\`\`\`text
<error output, logs, file snippet — trimmed to the relevant part>
\`\`\`

**Repro steps** (if not obvious from "Ran")
1.

**Workaround** (if any)
<what you did to get unblocked; note any files hand-edited and the state left behind>

**Suspected cause / where to look** (optional)
<file or module, if you have a guess>
~~~

## Body template: feature or task

~~~markdown
- **Type:** feature | task
- **Workspace:** ${workspaceName} (stage or phase you were in)
- **Area:** <e.g. CLI | MCP tool | plugin skill | generated files | containers | routing/Caddy | ports | docs | app code>

**Ask**
<what should exist or change — numbered if more than one>

**Why**
<what prompted it: who asked, what it unblocks>

**Where to change**
<files, modules, or commands, if known>

**Done when**
<the observable outcome that closes it>
~~~
`;
}
