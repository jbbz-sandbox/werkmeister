---
"werkmeister": minor
"werkmeister-core": minor
---

SW-784: usage shows active time beside wall clock. Active time is the time between transcript messages less than 5 minutes apart, so waits on a person and idle stretches don't count. It is `activeMinutes` on the `workspace-usage` tool's result (workspace total and per session, also in its text line) and on `WorkspaceUsage`/`SessionUsage` in the SDK, and close-out's `usage.json` carries it next to `wallClockMinutes` (`schema` stays 1). `usage.md` gets an `Active:` line. Two sessions open at once count their shared time once. OpenCode sessions report `null`.
