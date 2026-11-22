## Description

**What it does:**

1. Clones the workspace repo (the origin of `<repos_root>/sandbox-workspace`, else `overrides.workspace_repo`) into a temporary bare clone, removed when the command ends. The shared checkout is never fetched into or written
2. On each record branch except the default one: writes `stage.done` for each stage at the commit that first filled its `output/`, and `pr.open` / `pr.merged` at GitHub's `createdAt` / `mergedAt` for each PR file's `url:` (through `gh`). The ticket comes from the branch's `usage.json`
3. Writes `ask` / `answer` pairs (AskUserQuestion, ExitPlanMode) from the workspace's Claude Code transcripts still on disk
4. Appends each new line to `~/.werkmeister/metrics/events-YYYY-MM.jsonl`, the month of the event's own time

Re-running adds nothing: a stage, a PR event or a transcript session already in the log is skipped.

It cannot rebuild `queue.*`, `gate.*`, `release` or wrap-up asks: nothing on disk holds them.

**When to use:**
- Once after upgrading to a version with the metrics event log, to cover earlier work
- Before transcripts age out (Claude Code prunes them after about 30 days), to keep their ask/answer times

The command only appends. Copy `~/.werkmeister/metrics` first if you want to undo a run.
