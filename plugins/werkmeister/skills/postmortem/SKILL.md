---
name: postmortem
description: "Run the post-mortem that comes before `werkmeister close-out` in a werkmeister workspace (a folder with .werkmeister/workspace.yml, or .sandbox/workspace.yml on an older workspace, above it): gather every problem in the run, agree with the person what changes so it doesn't recur, write postmortem.md and act on each change. Use when the user says 'close out', 'post-mortem', 'postmortem', 'retro' or 'what went wrong in this run', shipped or abandoned."
---

# postmortem — lessons before close-out

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename keeps `~/.sandbox/` or `.sandbox/` instead; use whichever exists.

Lessons found mid-run are lost when the workspace is removed unless someone asks
for them on purpose. `werkmeister close-out` refuses until `postmortem.md` exists at
the workspace root, unless the person says to skip it
(`--skip-postmortem "<reason>"`, MCP `skip_postmortem`). Never skip it on your own.

1. **Gather.** List each problem with where you found it. Ask nothing yet.
   - **PRs:** each PR file's `url:` (ICM `stages/*/output/pr-*.md`, JIT
     `.werkmeister/notes/pr-*.md`) → `gh pr checks <url>` and
     `gh pr view <url> --json commits,reviews,comments`. Failed checks, Auto-fix
     commits, reviews or comments that asked for changes.
   - **Issues filed from the run:** issue bodies name the workspace, so
     JQL `text ~ "<workspace>"`, or
     `gh issue list -R jbbz-sandbox/werkmeister --search "<workspace>" --state all`.
   - **Deviations:** ICM `stages/*/output/` (deviations in `exercise.md`, FAIL
     rows); JIT `.werkmeister/notes/`.
   - **Gate failures and the person's corrections:** this session's transcript,
     and the workspace's other sessions through the werkmeister
     `claude-transcript` MCP tool when it is available.
   - One cause is one problem: a CI failure and the issue filed for it are one row.
2. **No problems:** write `postmortem.md` with `Problems: none`, commit and push
   it (step 6), say so, and go on. Ask nothing.
3. **For each problem** show the problem, its source and its cause, and propose
   what could have been done differently plus the action that makes it stick
   (step 5). The person accepts, edits or rejects each. Batch them in one
   question where the asking tool allows. Ask even in an `autonomous` run:
   close-out is the person's step.
4. **Write `postmortem.md`** at the workspace root:

   ```markdown
   # Post-mortem — <workspace>

   Date: YYYY-MM-DD
   Issue: <issue ref or none>

   | # | Problem | Source | Cause | Agreed change | Action |
   |---|---|---|---|---|---|
   | 1 | <what went wrong> | <PR #440 CI `test`, transcript, exercise.md, SW-107 …> | <why> | <what changes> | <link or path, or `rejected: <why>`> |
   ```

5. **Do each accepted action** and put its link or path in Action:
   - **SW issue** (bug, feature or task): the workspace's `issues-report.md`;
     `werkmeister issue create --project SW …`.
   - **Standards edit:** in the standards tree (`werkmeister standards check` prints
     it). Show the person the edit before saving it.
   - **Memory entry:** your memory tool, in the project memory every workspace
     shares. Never a note inside the workspace: it is removed at close-out.
   - **`_shared/` or other generated file:** an SW issue. The workspace's copy
     is regenerated, and removed at close-out.
6. **Commit and push `postmortem.md`** on the workspace (record) branch. Then
   close out as `workspace-pr` step 6 says: ask the person before
   `werkmeister close-out`.
