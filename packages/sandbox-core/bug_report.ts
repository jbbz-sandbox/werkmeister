/**
 * The bug-filing guide both context strategies write into a workspace: where a
 * bug goes — fixed here if this workspace's changes caused it, otherwise an
 * issue on the sandbox repo or in the machine's issue tracker
 * (`overrides.issue_tracker`: the Jira project, or the GitHub issues of the
 * registry repo it belongs to) — and the issue body. icm writes it to
 * `_shared/bug-report.md`, jit to `.sandbox/bug-report.md`; each strategy's
 * CLAUDE.md points at its copy.
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
      `| app code in a worktree | ${where} | \`gh issue create -R <owner>/<repo>\` |`,
      'Search first: `gh issue list -R <owner>/<repo> --search "<keywords>" --state all`. If it exists, comment on it instead.',
    ];
  }
  const project = /^([A-Z][A-Z0-9]+)-\d+$/.exec(jiraId)?.[1];
  const base = (loadJira().base_url ?? "").trim().replace(/\/+$/, "");
  const where = `Jira${project ? `, project \`${project}\`` : " — ask the person which project"}${base ? ` (${base})` : ""}`;
  return [
    `| app code in a worktree | ${where} | the Atlassian MCP tools if connected; otherwise hand the person the title and body to file |`,
    `Search first: JQL \`${project ? `project = ${project} AND ` : ""}text ~ "<keywords>"\`. If it exists, comment on it instead. (Sandbox-tool bugs: \`gh issue list -R ${SANDBOX_ISSUES_REPO} --search "<keywords>" --state all\`.)`,
  ];
}

export function buildBugReportMd(
  workspaceName: string,
  jiraId = "",
  tracker: IssueTracker = loadIssueTracker(),
  repos: string[] = tracker === "github" ? githubIssueRepos() : [],
): string {
  const [appRow, searchStep] = appCodeRouting(tracker, jiraId.trim(), repos);
  return `# Filing a bug

## New or existing?

Decide this first.

- **New — this workspace's changes caused it** (the bug is in code changed on this branch, committed or not, and does not happen on the base branch): fix it here, in the current stage or phase. Do **not** file an issue.
- **Existing — it was already there** (it happens on the base branch, or it is in code this workspace has not touched, including the \`sandbox\` tool itself): file it as an issue where it belongs (table below), then carry on. Fix it here only if the current task depends on it, and say so in the issue.

Not sure? Check whether it happens on the base branch. If you still can't tell, ask the person — don't guess.

Log an existing bug when you find it, even if the notes are rough. Each issue must stand alone: a later agent should be able to fix it without re-running this workspace or asking follow-up questions.

## Where (existing bugs only)

| Bug is in | File at | Command |
|---|---|---|
| the \`sandbox\` tool: CLI, MCP tools, plugin skills, generated files (\`.sandbox/\`, \`docker-compose.yml\`, \`.env\`, \`CLAUDE.md\`, context files), containers, ports, Caddy routing, workspace init/teardown | https://github.com/${SANDBOX_ISSUES_REPO}/issues | \`gh issue create -R ${SANDBOX_ISSUES_REPO}\` |
${appRow}

## How

1. ${searchStep}
2. Title: one-line summary. Body: the template below (with \`gh\`, via \`--body-file\`).
3. Paste exact commands and error output — don't paraphrase.
4. Tell the person the issue URL, then resume what you were doing.

## Body template

~~~markdown
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
`;
}
