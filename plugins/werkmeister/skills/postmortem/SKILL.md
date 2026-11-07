---
name: postmortem
description: "Run the post-mortem that comes before `werkmeister workspace close` in a workspace (a folder with .werkmeister/workspace.yml above it): gather every problem in the run, agree with the person what changes so it doesn't recur, write postmortem.md and act on each change. Use when the user says 'close out', 'post-mortem', 'postmortem', 'retro' or 'what went wrong in this run', shipped or abandoned."
---

# postmortem — lessons before close-out

> Paths: `~/.werkmeister/` and a workspace's `.werkmeister/` are the current names. A machine or workspace set up before the rename moves its old directories with `werkmeister machine migrate`.

Lessons found mid-run are lost when the workspace is removed unless someone asks
for them on purpose. `werkmeister workspace close` refuses until `postmortem.md` exists at
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
   - **Review leftovers:** every `left:` row in each `review.md` the run wrote
     (ICM `stages/*/output/review.md`;
     `find stages .werkmeister -name review.md 2>/dev/null` finds the rest;
     never search the code worktrees, whose own `review.md` files are not this
     run's). List
     each with its file. They are not problems: step 4 triages them.
   - **Gate failures and the person's corrections:** this session's transcript,
     and the workspace's other sessions through the werkmeister
     `claude-transcript` MCP tool when it is available.
   - One cause is one problem: a CI failure and the issue filed for it are one row.
2. **No problems and no `left:` rows:** write `postmortem.md` with
   `Problems: none`, commit and push it (step 7), say so, and go on. Ask nothing.
   With `left:` rows but no problems, skip step 3 and still run step 4.
3. **For each problem** show the problem, its source and its cause, and propose
   what could have been done differently plus the action that makes it stick
   (step 6). The person accepts, edits or rejects each. Batch them in one
   question where the asking tool allows. Ask even in an `autonomous` run:
   close-out is the person's step. Decide file or known issue by cost, not by
   whether a workaround exists. File a tracker issue, and propose fixing it,
   when the problem costs time or efficiency and will happen again: a wait,
   rerun or manual step every run hits is a cost every run pays, however easy
   the workaround (a gate that waits on its own load, a flaky test that fails
   one run in five). Also file when it could lose data or is a security gap.
   Propose a known-issue row (step 4) only for a problem seen once or rarely
   whose workaround costs next to nothing (a one-off network blip a rerun
   cleared).
4. **Triage each `left:` row,** one question per row, in order. Ask even in an
   `autonomous` run. Show the finding, its file and its `left:` reason, then offer
   these, recommending **known issue** only for a rare finding with a
   near-free workaround, and **file** when it will recur and cost time (step 3):
   - **file:** a tracker issue through the workspace's `issues-report.md`
     (search first, as it says). The body names the workspace and the PR URL
     (the PR file's `url:`); relate it to the workspace's issue where the filing
     command allows it.
   - **known issue:** a row in the known-issues file of the folder that holds
     the workspace (`../KNOWN-ISSUES.md`, created if missing): the finding,
     where it came from, and its proposed fix.
   - **drop:** with the person's reason.

   Do each choice as it is made and record it in the leftovers table (step 5).
5. **Write `postmortem.md`** at the workspace root:

   ```markdown
   # Post-mortem — <workspace>

   Date: YYYY-MM-DD
   Issue: <issue ref or none>

   | # | Problem | Source | Cause | Agreed change | Action |
   |---|---|---|---|---|---|
   | 1 | <what went wrong> | <PR #440 CI `test`, transcript, exercise.md, SW-107 …> | <why> | <what changes> | <link or path, or `rejected: <why>`> |

   ## Review leftovers

   | # | Finding | From | Decision | Link or reason |
   |---|---|---|---|---|
   | 1 | <the left: row> | <stages/03_implement/output/review.md> | file / known issue / drop | <issue URL, `../KNOWN-ISSUES.md`, or why dropped> |
   ```

   With no `left:` rows, write `Review leftovers: none` in place of that table.

6. **Do each accepted action** and put its link or path in Action. Rank them:
   pick the highest one that makes the lesson reach every installation of werkmeister.
   1. **Shipped change, through an SW issue** (bug, feature or task): a code,
      skill or generated-text change. A `_shared/` or other generated file belongs
      here too: the workspace's copy is regenerated, and removed at close-out. Use
      the workspace's `issues-report.md`; `werkmeister issue create --project SW …`.
   2. **Standards edit:** in the standards tree (`werkmeister standards check`
      prints it). Show the person the edit before saving it.
   3. **Memory entry, only for one person's own preferences,** such as their PR
      rules. It lives in Claude Code's auto-memory on one machine
      (`~/.claude/projects/<project>/memory/`), in no repo, and never ships with
      werkmeister: another developer's Claude, or yours on another machine, never
      sees it. Never use it for a lesson about how werkmeister works. Never a
      note inside the workspace: it is removed at close-out.

   **Known issue** (a row in `../KNOWN-ISSUES.md`, as in step 4) is the action
   only for a rare problem with a near-free workaround (step 3), in place of
   the ranks above; a recurring cost is filed and fixed through rank 1.

   **Already enforced by `<check>`** (for example `name:check`) is also an action
   when a shipped check already catches the problem: confirm it does, name the
   check in Action, and file nothing.
7. **Commit and push `postmortem.md`** on the workspace (record) branch. Then
   close out as `workspace-pr` step 6 says: ask the person before
   `werkmeister workspace close`.
