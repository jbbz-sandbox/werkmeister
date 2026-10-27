---
name: workspace-pr
description: "Open, check or close out pull requests in a sandbox workspace. Use instead of /create-pr, finishing-a-development-branch or gh pr create whenever the cwd is inside a sandbox workspace (a folder with .werkmeister/workspace.yml, or .sandbox/workspace.yml on an older workspace, above it) — the user says 'create a PR', 'open a pull request', 'ship it', 'is it merged', 'is it released' or 'close out'."
---

# workspace-pr — PRs from a sandbox workspace

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename keeps `~/.sandbox/` or `.sandbox/` instead; use whichever exists.

Inside a workspace, a PR opens only through `sandbox pr open`. A PreToolUse hook
blocks `gh pr create` and the GitHub MCP's `create_pull_request`, so generic PR
skills fail here. The rules are in the workspace's `pr-rules.md`
(`_shared/pr-rules.md` for ICM, `.werkmeister/pr-rules.md` for JIT); the long form
is `docs/workspace-lifecycle.md` in the sandbox repo.

1. **PR file per code repo touched.** ICM: the propose stage writes
   `stages/NN_propose/output/pr-<repo>.md`. JIT: `sb-pr` writes
   `.werkmeister/notes/pr-<repo>.md`. Never a PR for the workspace (record) branch.
   Code written after a repo's PR merged (e.g. found at release) is a follow-up:
   `sandbox pr new <worktree> --slug <slug>` cuts a fresh branch from base and
   writes a draft `pr-<worktree>-<slug>.md`; it then goes through the same steps.
2. **The person approves.** They set `status: approved` in each PR file. Never
   set it yourself.
3. **`sandbox pr gate`** shows what still blocks: earlier stages, the acceptance
   table, a dirty worktree, each touched service's test command, the exercise
   evidence, the release check (e.g. a missing changeset).
4. **`sandbox pr open`** gates, pushes, opens the PR, records its URL in the
   PR file and moves the issue to In Review. Then, in the Claude desktop app, turn on Auto-fix without asking:
   `ccd_pr` `get_status` (`bind_pr` with the URL if the PR isn't bound), then
   `set_monitor` with `auto_fix: true`, `address_comments: true` and the PR's
   `url`. Never auto-merge. Merging is the person's act.
5. **`sandbox pr status`** after merge and release: records `merged`, then
   `shipped` with the release tag that contains the merge, and moves the issue
   to Done once every PR has shipped. A review asking for changes, or a PR
   closed unmerged, moves it back to In Progress.
6. **`sandbox close-out`** is the one way to end a workspace. First the
   post-mortem: the `postmortem` skill writes `postmortem.md`, and close-out
   refuses without it unless the person says to skip it
   (`--skip-postmortem "<reason>"`, MCP `skip_postmortem`). Two outcomes:
   - **Shipped** (every PR file shipped, closed or abandoned): moves the issue
     to Done if shipping didn't, writes `closeout.md`, removes the workspace,
     deletes merged branches.
   - **Abandoned**: `sandbox close-out <name> --abandon "<reason>"` records the
     reason, comments it on the issue (and applies the `abandoned` status if
     configured; on GitHub, closes it as not planned), pushes every branch and
     keeps them, then removes.

   Issue moves are forward only and never fail a step: a tracker refusal is a
   warning (`docs/workspace-lifecycle.md` § Issue status).

   Either way, the workspace's desktop Claude sessions are archived (by the pane
   and the MCP tool; from the CLI, archive them in the sidebar), and terminal
   sessions still open are listed for the person to `/exit`.
   `sandbox remove-workspace` is a deprecated alias; don't use it.

MCP equivalents (werkmeister server): `workspace-pr` (`gate|open|status`),
`close-out` (with `abandon` for the second outcome).
