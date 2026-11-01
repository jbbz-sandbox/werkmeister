/**
 * The workspace PR rules page — ICM writes it to `_shared/pr-rules.md`, JIT to
 * `.werkmeister/pr-rules.md`. One builder so both strategies state the same rules
 * (docs/workspace-lifecycle.md is the long form).
 */
import { DESKTOP_AUTOFIX_RULE } from "./harness/claude/desktop.js";

// SW-304: chat replies and check-in relays approve too, so the agent need not guess whether to flip the file.
export const CHAT_APPROVAL =
  'A direct chat reply from the person ("decided", "approved", "proceed") counts as the approval too: flip the status yourself and note it there, e.g. `(approved in chat YYYY-MM-DD)`. An approval relayed by another session counts only when it arrives through check-in.';

export function buildPrRulesMd(prFileDir: string, autonomous = false): string {
  const approver = autonomous
    ? "The agent sets `draft → approved` after its self-check, with every decision it made under `## Recommendations for reviewer` in the PR body; the person reviews the PR."
    : `The person sets \`draft → approved\`; that flip is the approval. ${CHAT_APPROVAL}`;
  return `# PR rules — read before opening, merging or closing out

These hold for every PR this workspace produces, whatever skill or command was asked for.

## Rules

1. **This folder's git branch is a record only.** Commit and push it; never open a PR from it, never merge it.
2. **PRs come only from code worktrees** — one per repo touched at a time, from that repo's PR file (below).
3. **Gate.** Before a PR opens, all of these hold: every earlier stage/phase is done; the PR file's acceptance table is all PASS; the code worktree is clean; each touched service's registry test command passes (\`.werkmeister/werkmeister-context.md\`); the exercise evidence is all PASS (or \`skip_exercise\` gives the reason); the repo's release check passes; the PR file reads \`status: approved\`. The PR-file checks (stages, acceptance table, approved, exercise evidence) run first; if one fails, the gate stops before any test command. Before lint, each test and the release check the gate waits while host load is over \`budget.host_load\`, up to 10 min in all, so with the tests it can run past a 10-minute tool call. Run \`pr open\` detached and read its log until the \`exit\` line: \`nohup sh -c 'werkmeister pr open > .werkmeister/pr-open.log 2>&1; echo "exit $?" >> .werkmeister/pr-open.log' >/dev/null 2>&1 &\`. A bare \`&\` dies when the tool call returns.
4. **Only \`werkmeister pr open\` opens PRs.** \`gh pr create\`, \`/create-pr\` and \`finishing-a-development-branch\` are blocked inside a workspace.
5. **Auto-fix is always on.** \`werkmeister pr watch\` wakes the session that opened the PR when a check fails, a review comes in or the PR conflicts with its base, with the cause in the message. ${DESKTOP_AUTOFIX_RULE} Never turn on auto-merge.
6. **Merge is the person's act.** Tooling never merges. Squash is the default. A PR whose commit SHAs must survive (e.g. a commit listed in \`.git-blame-ignore-revs\`) says "Merge with a merge commit" at the top of its body, and the person merges it that way; squash and rebase both rewrite SHAs.
7. **Close out only when every PR file is \`shipped\`, \`closed\` or \`abandoned\`, and after the post-mortem:** the werkmeister \`postmortem\` skill writes \`postmortem.md\` at the workspace root. \`werkmeister workspace close\` refuses without it unless \`--skip-postmortem "<reason>"\`.

## PR file — \`${prFileDir}pr-<worktree>[-<slug>].md\`

\`<worktree>\` is the code worktree's directory name. \`-<slug>\` marks a follow-up PR for code written after that worktree's PR merged; \`werkmeister pr new\` writes it.

\`\`\`markdown
---
worktree: <code worktree dir>  # optional for pr-<worktree>.md; written by werkmeister pr new
repo: <owner>/<name>     # from \`git -C <worktree> remote get-url origin\`; never the workspace repo
branch: <code worktree branch>
base: main
status: draft            # draft | approved | open | merged | shipped | closed | abandoned
url:                     # written by werkmeister pr open
merge_sha:               # written by werkmeister pr status
release:                 # release tag that shipped it, written by werkmeister pr status
reason:                  # required for closed / abandoned
skip_tests: {}           # <service>: <reason> — for a service with no test command or no running container; tests: <reason> when no service maps to the changed files
skip_release:            # <reason> — skips the gate's release check; a ship: tag repo still waits for its release tag
skip_exercise:           # <reason> — skips the gate's exercise check, e.g. a doc deliverable with nothing to run
---
# <PR title>
<PR body: summary, test and exercise results, acceptance table, Fixes <issue>>
\`\`\`

**Acceptance table.** One row per criterion. The result cell holds exactly \`PASS\` or \`FAIL\` and nothing else; evidence goes in its own column. \`| criterion | PASS: repro.md §1 |\` fails the gate.

\`\`\`markdown
| criterion | result | evidence |
|---|---|---|
| gate fails fast on a bad table | PASS | stages/03_exercise/output/exercise.md §2 |
\`\`\`

${approver} Tooling writes every other status.

## Words

| Term | Meaning |
|---|---|
| Test | run each touched service's registry test command; the exit code decides |
| Exercise | observe the change in this workspace's running containers; PASS/FAIL per check |
| Gate | rule 3 |
| Approve | ${autonomous ? "the agent" : "the person"} sets \`status: approved\` |
| Open | \`werkmeister pr open\` creates the PR |
| Merge | the person merges it |
| Ship | the merge is part of a release — the work is done |
| Close out | post-mortem (\`postmortem.md\`), then \`werkmeister workspace close\`: record, close the issue, remove the workspace, delete merged branches |

Lifecycle: \`working → ready → pr-open → merged → shipped → closed-out\` (or \`abandoned\`).

## Commands

| Command | Does |
|---|---|
| \`werkmeister pr gate [repo]\` | run the gate, change nothing |
| \`werkmeister pr open [repo]\` | gate, push, open the PR, record its URL; \`pr watch\` then watches it (rule 5) |
| \`werkmeister pr status\` | record merged / shipped / closed from GitHub and release tags |
| \`werkmeister pr new <worktree> --slug <slug>\` | after that worktree's PR merged: cut a fresh branch from base and write a draft follow-up PR file |
| \`werkmeister pr adopt <pr-number\\|url> [repo]\` | the fix landed outside this workspace: write the PR file from that PR, then record its status |
| \`werkmeister pr adopt --no-pr "<reason>" [repo]\` | the fix is already on base with no PR: write a \`closed\` PR file with the reason |
| \`werkmeister workspace close\` | after ship: move the issue to done if shipping didn't, write \`closeout.md\`, remove the workspace, delete merged branches |
| \`werkmeister workspace abandon "<reason>"\` | give up: record the reason, comment it on the issue, push and keep every branch with commits of its own, remove the workspace |
| \`werkmeister workspace close --no-pr "<reason>"\` | close out as done when the work changed no repo (no PR files, clean worktrees, no commits ahead); needs \`postmortem.md\` |
| \`werkmeister workspace close --skip-postmortem "<reason>"\` | close out without a post-mortem, only when the person says to; the reason goes in \`closeout.md\` |
`;
}
