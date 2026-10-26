---
name: sb-pr
description: "Begin the PR/finishing phase in a sandbox workspace. Use when implementation and tests are done and a pull request is about to be created — the user says 'create a PR', 'ship it', 'open a pull request', or 'finish this branch'."
---

# sb-pr — enter the PR/finishing phase

PRs open only through `sandbox pr open` (`.sandbox/pr-rules.md`). `gh pr create`,
`/create-pr` and `superpowers:finishing-a-development-branch` are blocked in a
workspace — don't reach for them.

1. **Self-review.** Invoke `sb-review` on the branch diff (vs the base branch)
   and address its findings before continuing.
2. **Write one PR file per repo touched:** `.sandbox/notes/pr-<repo>.md`, in the
   format of `.sandbox/pr-rules.md`, at `status: draft`. Code written after a
   repo's PR merged is a follow-up: `sandbox pr new <worktree> --slug <slug>`
   cuts a fresh branch from base and writes a draft `pr-<worktree>-<slug>.md`.
   - **Title** (the first `#` heading): `<type>(<optional scope>): <ISSUE-ID> <short description>` —
     conventional-commit types (`feat`, `fix`, `refactor`, `chore`, `docs`,
     `test`, `ci`, `perf`); scope optional, use it when targeting a specific
     app/package.
     Example: `feat(backend): PROJ-1125 Add rating field to the product payload`
     `<ISSUE-ID>` is the workspace's issue (`issue_id` in
     `.sandbox/workspace.yml`), as the issue tracker writes it. No issue → omit it.
   - **Body** (everything after the title):

     ```markdown
     ## Summary
     <1-3 bullet points covering what and why>

     ## Test plan
     <checklist of verification steps>

     ## Acceptance
     | Criterion | Result |
     |---|---|
     | <criterion> | PASS |

     Refs: <ISSUE-ID>

     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     ```

   - A repo whose registry entry has `ship: tag` and a `release_check` needs its
     release entry (e.g. a changeset) committed on the branch, or `skip_release`
     with a reason.
3. **Approval is the person's.** Ask them to read the PR file and set
   `status: approved`. Don't set it yourself.
4. **Open:** run `sandbox pr open`. It runs the gate (tests, exercise evidence,
   release check), pushes, opens the PR, moves the issue to the review status
   (`overrides.issue_statuses.in_review`, default `In Review`, or the label `status: in review` on GitHub;
   the full flow is To Do → In Progress at the first stage → In Review here → Done at ship,
   docs/workspace-lifecycle.md § Issue status),
   and records the URL in the PR file. A failed gate check names what to fix.
   Then, in the Claude desktop app, turn on Auto-fix without asking: `ccd_pr`
   `get_status` (`bind_pr` with the URL if unbound), then `set_monitor` with
   `auto_fix: true`, `address_comments: true` and the PR's `url`. Never auto-merge.
5. **Checkpoint:** suggest `sb-handoff` so the PR state survives into the next
   session. After merge and release: `sandbox pr status`, then ask the person before `sandbox close-out`.
