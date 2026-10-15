/**
 * The workspace PR rules page — ICM writes it to `_shared/pr-rules.md`, JIT to
 * `.sandbox/pr-rules.md`. One builder so both strategies state the same rules
 * (docs/workspace-lifecycle.md is the long form).
 */

export function buildPrRulesMd(prFileDir: string): string {
  return `# PR rules — read before opening, merging or closing out

These hold for every PR this workspace produces, whatever skill or command was asked for.

## Rules

1. **This folder's git branch is a record only.** Commit and push it; never open a PR from it, never merge it.
2. **PRs come only from code worktrees** — one per repo touched, from that repo's PR file (below).
3. **Gate.** Before a PR opens, all of these hold: every earlier stage/phase is done; the PR file's acceptance table is all PASS; the code worktree is clean; each touched service's registry test command passes (\`.sandbox/sandbox-context.md\`); the exercise evidence is all PASS; the repo's release check passes; the PR file reads \`status: approved\`.
4. **Only \`sandbox pr open\` opens PRs.** \`gh pr create\`, \`/create-pr\` and \`finishing-a-development-branch\` are blocked inside a workspace.
5. **Merge is the person's act.** Tooling never merges.
6. **Close out only when every PR file is \`shipped\`, \`closed\` or \`abandoned\`.**

## PR file — \`${prFileDir}pr-<repo>.md\`

\`<repo>\` is the code worktree's directory name.

\`\`\`markdown
---
repo: <owner>/<name>     # the code repo on GitHub; never the workspace repo
branch: <code worktree branch>
base: main
status: draft            # draft | approved | open | merged | shipped | closed | abandoned
url:                     # written by sandbox pr open
merge_sha:               # written by sandbox pr status
release:                 # release tag that shipped it, written by sandbox pr status
reason:                  # required for closed / abandoned
skip_tests: {}           # <service>: <reason> — for a service with no test command or no running container
skip_release:            # <reason> — skips the gate's release check; a ship: tag repo still waits for its release tag
---
# <PR title>
<PR body: summary, test and exercise results, acceptance table (PASS/FAIL), Fixes <issue>>
\`\`\`

The person sets \`draft → approved\`; that flip is the approval. Tooling writes every other status.

## Words

| Term | Meaning |
|---|---|
| Test | run each touched service's registry test command; the exit code decides |
| Exercise | observe the change in this workspace's running containers; PASS/FAIL per check |
| Gate | rule 3 |
| Approve | the person sets \`status: approved\` |
| Open | \`sandbox pr open\` creates the PR |
| Merge | the person merges it |
| Ship | the merge is part of a release — the work is done |
| Close out | \`sandbox close-out\`: record, close the issue, remove the workspace, delete merged branches |

Lifecycle: \`working → ready → pr-open → merged → shipped → closed-out\` (or \`abandoned\`).

## Commands

| Command | Does |
|---|---|
| \`sandbox pr gate [repo]\` | run the gate, change nothing |
| \`sandbox pr open [repo]\` | gate, push, open the PR, record its URL |
| \`sandbox pr status\` | record merged / shipped / closed from GitHub and release tags |
| \`sandbox close-out\` | after ship: close the issue, write \`closeout.md\`, remove the workspace, delete merged branches |
| \`sandbox remove-workspace <name> --abandon "<reason>"\` | give up: record the reason, then remove |
`;
}
