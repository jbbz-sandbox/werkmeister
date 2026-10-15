---
name: workspace-pr
description: "Open, check or close out pull requests in a sandbox workspace. Use instead of /create-pr, finishing-a-development-branch or gh pr create whenever the cwd is inside a sandbox workspace (a folder with .sandbox/workspace.yml above it) — the user says 'create a PR', 'open a pull request', 'ship it', 'is it merged', 'is it released' or 'close out'."
---

# workspace-pr — PRs from a sandbox workspace

Inside a workspace, a PR opens only through `sandbox pr open`. A PreToolUse hook
blocks `gh pr create` and the GitHub MCP's `create_pull_request`, so generic PR
skills fail here. The rules are in the workspace's `pr-rules.md`
(`_shared/pr-rules.md` for ICM, `.sandbox/pr-rules.md` for JIT); the long form
is `docs/workspace-lifecycle.md` in the sandbox repo.

1. **PR file per code repo touched.** ICM: the propose stage writes
   `stages/NN_propose/output/pr-<repo>.md`. JIT: `sb-pr` writes
   `.sandbox/notes/pr-<repo>.md`. Never a PR for the workspace (record) branch.
2. **The person approves.** They set `status: approved` in each PR file. Never
   set it yourself.
3. **`sandbox pr gate`** shows what still blocks: earlier stages, the acceptance
   table, a dirty worktree, each touched service's test command, the exercise
   evidence, the release check (e.g. a missing changeset).
4. **`sandbox pr open`** gates, pushes, opens the PR and records its URL in the
   PR file. Then, in the Claude desktop app, turn on Auto-fix without asking:
   `ccd_pr` `get_status` (`bind_pr` with the URL if the PR isn't bound), then
   `set_monitor` with `auto_fix: true`, `address_comments: true` and the PR's
   `url`. Never auto-merge. Merging is the person's act.
5. **`sandbox pr status`** after merge and release: records `merged`, then
   `shipped` with the release tag that contains the merge.
6. **`sandbox close-out`** once every PR file is shipped, closed or abandoned:
   closes the issue, writes `closeout.md`, removes the workspace, deletes merged
   branches. To give up instead:
   `sandbox remove-workspace <name> --abandon "<reason>"`.

MCP equivalents (sandbox-workspace server): `workspace-pr` (`gate|open|status`),
`close-out`, `remove-workspace` with `abandon`.
