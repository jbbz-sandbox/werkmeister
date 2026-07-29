---
name: sb-pr
description: "Begin the PR/finishing phase in a sandbox workspace. Use when implementation and tests are done and a pull request is about to be created — the user says 'create a PR', 'ship it', 'open a pull request', or 'finish this branch'."
---

# sb-pr — enter the PR/finishing phase

Run these steps in order. Steps 1 and 2 are gates — a failure stops the PR.

1. **Pre-PR gate — local CI checks.** Run the repo's lint, tests, type checks,
   and build. Any failure → fix it first. Never create a PR on failing local
   checks.
2. **Self-review.** Invoke `sb-review` on the branch diff (vs the base branch)
   and address its findings before continuing.
3. **PR conventions:**
   - **Title:** `<type>(<optional scope>): <JIRA-ID> <short description>` —
     conventional-commit types (`feat`, `fix`, `refactor`, `chore`, `docs`,
     `test`, `ci`, `perf`); scope optional, use it when targeting a specific
     app/package.
     Example: `feat(product-api): PROJ-1125 Add rating field to Product type`
   - **Body:**

     ```markdown
     ## Summary
     <1-3 bullet points covering what and why>

     ## Test plan
     <checklist of verification steps>

     Refs: <JIRA-ID>

     🤖 Generated with [Claude Code](https://claude.com/claude-code)
     ```

   - **Jira:** transition the ticket named in the title to **In Development**
     (use your configured Jira tooling; connection specifics live in your
     personal config, not this skill).
4. **Branch mechanics:** use `superpowers:finishing-a-development-branch` if
   installed; if not, say so once and create the PR with `gh pr create`.
5. **Checkpoint:** after the PR exists, suggest `sb-handoff` so the PR state
   survives into the next session.
