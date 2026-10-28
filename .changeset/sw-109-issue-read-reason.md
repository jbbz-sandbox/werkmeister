---
"werkmeister-core": patch
"werkmeister": patch
---

SW-109: when `pr open` (or any lifecycle move) can't read the issue, it retries the read once, and if that fails too the warning now gives the reason (Jira's HTTP status and message, the network error code, the MCP fallback, or `gh`'s error) and the `werkmeister issue update <ref> --status … --comment …` command that makes the move by hand. `werkmeister issue view` prints the same reasons when it can't read an issue.
