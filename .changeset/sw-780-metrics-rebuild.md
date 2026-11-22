---
"werkmeister": minor
"werkmeister-core": minor
---

New `werkmeister metrics rebuild` (SW-780) backfills `~/.werkmeister/metrics` with work from before the event log existed. It writes `stage.done` from record-branch stage commits, `pr.open` / `pr.merged` from GitHub's `createdAt` / `mergedAt` for each PR file, and `ask` / `answer` pairs from the Claude Code transcripts still on disk. It reads the workspace repo through a temporary bare clone that it removes on exit, and never fetches into the shared checkout. Re-running it adds nothing. `recordEvent` now returns whether the line was written.
