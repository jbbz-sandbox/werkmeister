## Description

**What it does:**

1. Clones the workspace repo (the origin of `<repos_root>/sandbox-workspace`, else `overrides.workspace_repo`) into a temporary bare clone, removed when the command ends. The shared checkout is never fetched into or written
2. On each record branch except the default one, first: copies the lines of its `metrics.jsonl`, the events its close-out pushed (a teammate's too), and caches its `usage.json` with the branch's git author email and its `.werkmeister/workspace.yml` `work_type` (`unknown` when the file can't be read or has none, never guessed) in `~/.werkmeister/metrics/usage-branches.jsonl`, rewritten each run, for the `metrics` report's per-person and per-work-type rollups
3. On each record branch: writes `stage.done` for each stage at the commit that first filled its `output/`, and `pr.open` / `pr.merged` at GitHub's `createdAt` / `mergedAt` for each PR file's `url:` (through `gh`). The ticket comes from the branch's `usage.json`
4. Writes `ask` / `answer` pairs (AskUserQuestion, ExitPlanMode) from the workspace's Claude Code transcripts still on disk
5. Writes `coverage` rows from the CI `coverage-summary` artifacts of each GitHub repo those PRs are in (through `gh`), one per package per run: `ci-pr` for a pull request run, `ci-main` for a merge-queue run
6. Appends each new line to `~/.werkmeister/metrics/events-YYYY-MM.jsonl`, the month of the event's own time

Re-running adds nothing: a stage, a PR event, a transcript session, a slice line or a CI run already in the log is skipped.

For a run closed out before its slice was pushed, it cannot rebuild `queue.*`, `gate.*`, `release` or wrap-up asks: nothing on disk holds them.

**When to use:**
- Once after upgrading to a version with the metrics event log, to cover earlier work
- Before the `metrics` report, for the team view: it brings in every teammate's closed-out runs
- Before transcripts age out (Claude Code prunes them after about 30 days), to keep their ask/answer times

The command only appends to the event log; `usage-branches.jsonl` is a cache it rewrites, or keeps as is with a warning when reading the branches' `usage.json` fails. Copy `~/.werkmeister/metrics` first if you want to undo a run.
