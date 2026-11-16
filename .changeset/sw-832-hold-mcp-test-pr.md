---
"werkmeister-core": patch
---

SW-832: while a workspace waits for capacity, the hook now also holds the MCP `test` tool and `workspace-pr` with `gate` or `open`, as it holds their Bash forms. `workspace-pr` `status` still runs.
