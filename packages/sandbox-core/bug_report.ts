/**
 * The bug-filing guide both context strategies write into a workspace: where a
 * bug goes — fixed here if this workspace's changes caused it, otherwise an
 * issue on the sandbox repo or the worktree repo — and the issue body. icm
 * writes it to `_shared/bug-report.md`, jit to `.sandbox/bug-report.md`; each
 * strategy's CLAUDE.md points at its copy.
 */

export const SANDBOX_ISSUES_REPO = "jbbz-sandbox/sandbox";

export function buildBugReportMd(workspaceName: string): string {
  return `# Filing a bug

## New or existing?

Decide this first.

- **New — this workspace's changes caused it** (the bug is in code changed on this branch, committed or not, and does not happen on the base branch): fix it here, in the current stage or phase. Do **not** file an issue.
- **Existing — it was already there** (it happens on the base branch, or it is in code this workspace has not touched, including the \`sandbox\` tool itself): file it as an issue in the repo it belongs to (table below), then carry on. Fix it here only if the current task depends on it, and say so in the issue.

Not sure? Check whether it happens on the base branch. If you still can't tell, ask the person — don't guess.

Log an existing bug when you find it, even if the notes are rough. Each issue must stand alone: a later agent should be able to fix it without re-running this workspace or asking follow-up questions.

## Where (existing bugs only)

| Bug is in | File at | Command |
|---|---|---|
| the \`sandbox\` tool: CLI, MCP tools, plugin skills, generated files (\`.sandbox/\`, \`docker-compose.yml\`, \`.env\`, \`CLAUDE.md\`, context files), containers, ports, Caddy routing, workspace init/teardown | https://github.com/${SANDBOX_ISSUES_REPO}/issues | \`gh issue create -R ${SANDBOX_ISSUES_REPO}\` |
| app code in a worktree | that repo's GitHub issues — find it with \`git -C <worktree> remote get-url origin\` | \`gh issue create -R <owner>/<repo>\` |

## How

1. Search first: \`gh issue list -R <owner>/<repo> --search "<keywords>" --state all\`. If it exists, comment on it instead.
2. Title: one-line summary. Body: the template below, via \`--body-file\`.
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
