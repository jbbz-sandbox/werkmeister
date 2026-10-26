/**
 * The workspace PR rules page — ICM writes it to `_shared/pr-rules.md`, JIT to
 * `.sandbox/pr-rules.md`. One builder so both strategies state the same rules
 * (docs/workspace-lifecycle.md is the long form).
 */

export function buildPrRulesMd(prFileDir: string, autonomous = false): string {
  const approver = autonomous
    ? "The agent sets `draft → approved` after its self-check, with every decision it made under `## Recommendations for reviewer` in the PR body; the person reviews the PR."
    : "The person sets `draft → approved`; that flip is the approval.";
  return `# PR rules — read before opening, merging or closing out

These hold for every PR this workspace produces, whatever skill or command was asked for.

## Rules

1. **This folder's git branch is a record only.** Commit and push it; never open a PR from it, never merge it.
2. **PRs come only from code worktrees** — one per repo touched at a time, from that repo's PR file (below).
3. **Gate.** Before a PR opens, all of these hold: every earlier stage/phase is done; the PR file's acceptance table is all PASS; the code worktree is clean; each touched service's registry test command passes (\`.sandbox/sandbox-context.md\`); the exercise evidence is all PASS (or \`skip_exercise\` gives the reason); the repo's release check passes; the PR file reads \`status: approved\`.
4. **Only \`sandbox pr open\` opens PRs.** \`gh pr create\`, \`/create-pr\` and \`finishing-a-development-branch\` are blocked inside a workspace.
5. **Auto-fix is always on.** Right after \`sandbox pr open\`, in the Claude desktop app: bind the PR to this session (\`ccd_pr\` \`get_status\`; \`bind_pr\` with the PR's URL if it isn't bound), then turn on Auto-fix with \`ccd_pr\` \`set_monitor\` (\`auto_fix: true\`, \`address_comments: true\`, the PR's \`url\`). Don't ask first. Never turn on auto-merge.
6. **Merge is the person's act.** Tooling never merges. Squash is the default. A PR whose commit SHAs must survive (e.g. a commit listed in \`.git-blame-ignore-revs\`) says "Merge with a merge commit" at the top of its body, and the person merges it that way; squash and rebase both rewrite SHAs.
7. **Close out only when every PR file is \`shipped\`, \`closed\` or \`abandoned\`.**

## PR file — \`${prFileDir}pr-<worktree>[-<slug>].md\`

\`<worktree>\` is the code worktree's directory name. \`-<slug>\` marks a follow-up PR for code written after that worktree's PR merged; \`sandbox pr new\` writes it.

\`\`\`markdown
---
worktree: <code worktree dir>  # optional for pr-<worktree>.md; written by sandbox pr new
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
skip_exercise:           # <reason> — skips the gate's exercise check, e.g. a doc deliverable with nothing to run
---
# <PR title>
<PR body: summary, test and exercise results, acceptance table (PASS/FAIL), Fixes <issue>>
\`\`\`

${approver} Tooling writes every other status.

## Words

| Term | Meaning |
|---|---|
| Test | run each touched service's registry test command; the exit code decides |
| Exercise | observe the change in this workspace's running containers; PASS/FAIL per check |
| Gate | rule 3 |
| Approve | ${autonomous ? "the agent" : "the person"} sets \`status: approved\` |
| Open | \`sandbox pr open\` creates the PR |
| Merge | the person merges it |
| Ship | the merge is part of a release — the work is done |
| Close out | \`sandbox close-out\`: record, close the issue, remove the workspace, delete merged branches |

Lifecycle: \`working → ready → pr-open → merged → shipped → closed-out\` (or \`abandoned\`).

## Commands

| Command | Does |
|---|---|
| \`sandbox pr gate [repo]\` | run the gate, change nothing |
| \`sandbox pr open [repo]\` | gate, push, open the PR, record its URL; then turn on Auto-fix (rule 5) |
| \`sandbox pr status\` | record merged / shipped / closed from GitHub and release tags |
| \`sandbox pr new <worktree> --slug <slug>\` | after that worktree's PR merged: cut a fresh branch from base and write a draft follow-up PR file |
| \`sandbox pr adopt <pr-number\\|url> [repo]\` | the fix landed outside this workspace: write the PR file from that PR, then record its status |
| \`sandbox pr adopt --no-pr "<reason>" [repo]\` | the fix is already on base with no PR: write a \`closed\` PR file with the reason |
| \`sandbox close-out\` | after ship: move the issue to done if shipping didn't, write \`closeout.md\`, remove the workspace, delete merged branches |
| \`sandbox close-out --abandon "<reason>"\` | give up: record the reason, comment it on the issue, push and keep every branch with commits of its own, remove the workspace |
`;
}
