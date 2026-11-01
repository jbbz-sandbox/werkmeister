---
"werkmeister-core": patch
"werkmeister": patch
---

SW-313: a `pr watch` wake can now fix the PR in a workspace without `autonomous`. The headless turn gets the workspace's autonomous allow and deny rules, and the pass waits for it. Refused calls that left the fix behind (uncommitted edits or unpushed commits) show as `auto-fix blocked: needs approval — …` in the log and as `needs-you` on the workspace card; refusals the agent got around are one `refused and retried` log line. A wake for a session that is still open, idle included, is held (with `needs-you`, `waiting for your open session: …`) instead of forking that session's history.
