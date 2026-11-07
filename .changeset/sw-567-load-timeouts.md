---
"werkmeister": patch
---

SW-567: the CLI's bins and spellings tests and the MCP proxy test survive a loaded host. Every spawn of the built CLI is async with 180 s of headroom (one starved start took 90-97 s against 60 s), the proxy test's request timeout is explicit instead of the SDK's 60 s default, and a spellings spawn is killed 10 s before the test timeout, so a case can no longer outlive its timeout and write a duplicate snapshot entry that dirtied the worktree.
