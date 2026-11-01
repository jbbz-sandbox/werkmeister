---
name: workspace-pr
description: "Open, check or close out pull requests in a workspace. Use instead of /create-pr, finishing-a-development-branch or gh pr create whenever the cwd is inside a workspace (a folder with .werkmeister/workspace.yml, or .werkmeister/workspace.yml on an older workspace, above it) — the user says 'create a PR', 'open a pull request', 'ship it', 'is it merged', 'is it released' or 'close out'."
---

# workspace-pr — PRs from a workspace

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename moves its old directories with `werkmeister machine migrate`.

Inside a workspace, a PR opens only through `werkmeister pr open`. A PreToolUse hook
blocks `gh pr create` and the GitHub MCP's `create_pull_request`, so generic PR
skills fail here. The rules are in the workspace's `pr-rules.md`
(`_shared/pr-rules.md` for ICM, `.werkmeister/pr-rules.md` for JIT); the long form
is `docs/workspace-lifecycle.md` in the werkmeister repo.

1. **PR file per code repo touched.** ICM: the propose stage writes
   `stages/NN_propose/output/pr-<repo>.md`. JIT: `w9r-pr` writes
   `.werkmeister/notes/pr-<repo>.md`. Never a PR for the workspace (record) branch.
   Code written after a repo's PR merged (e.g. found at release) is a follow-up:
   `werkmeister pr new <worktree> --slug <slug>` cuts a fresh branch from base and
   writes a draft `pr-<worktree>-<slug>.md`; it then goes through the same steps.
2. **The person approves.** They set `status: approved` in each PR file. Never
   set it yourself.
3. **`werkmeister pr gate`** shows what still blocks: earlier stages, the acceptance
   table, a dirty worktree, each touched service's test command, the exercise
   evidence, the release check (e.g. a missing changeset).
4. **`werkmeister pr open`** gates, pushes, opens the PR, records its URL in the
   PR file and moves the issue to In Review. `werkmeister pr watch` then wakes this
   session on a failed check, a review or a conflict (rule 5); don't turn on the
   desktop app's Auto-fix. Never auto-merge. Merging is the person's act.
5. **`werkmeister pr status`** after merge and release: records `merged`, then
   `shipped` with the release tag that contains the merge, and moves the issue
   to Done once every PR has shipped. A review asking for changes, or a PR
   closed unmerged, moves it back to In Progress.
6. **`werkmeister workspace close`** is the one way to end a workspace. First the
   post-mortem: the `postmortem` skill writes `postmortem.md`, and close-out
   refuses without it unless the person says to skip it
   (`--skip-postmortem "<reason>"`, MCP `skip_postmortem`). Three outcomes:
   - **Shipped** (every PR file shipped, closed or abandoned): moves the issue
     to Done if shipping didn't, writes `closeout.md`, removes the workspace,
     deletes merged branches.
   - **Done, no PR needed** (no PR files because the work changed no repo,
     e.g. a fix in `~/.claude`): `werkmeister workspace close --no-pr "<reason>"`
     (MCP `no_pr`). Refused unless every code worktree is clean with no commits
     ahead of its base. Moves the issue to Done; never counted as abandoned.
   - **Abandoned**: `werkmeister workspace abandon "<reason>" <name>` records the
     reason, comments it on the issue (and applies the `abandoned` status if
     configured; on GitHub, closes it as not planned), pushes every branch and
     keeps them, then removes.

   Issue moves are forward only and never fail a step: a tracker refusal is a
   warning (`docs/workspace-lifecycle.md` § Issue status).

   Either way, the workspace's desktop Claude sessions are archived (by the pane
   and the MCP tool; from the CLI, archive them in the sidebar), and terminal
   sessions still open are listed for the person to `/exit`.
   `werkmeister remove-workspace` is a deprecated alias; don't use it. <!-- docs-check: ignore -->

MCP equivalents (werkmeister server): `workspace-pr` (`gate|open|status`),
`close-out` (with `abandon` for the second outcome).
