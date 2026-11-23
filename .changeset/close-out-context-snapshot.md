---
"werkmeister": patch
---

`werkmeister workspace close` and `abandon` write `context.md` and `context.json` into the workspace record, next to `usage.md`, and commit them on the record branch (SW-318). Per Claude Code session they record the peak context size and % of the model's window, each compaction (turn, stage, size before and after), the first-turn baseline with the `/context` breakdown by category (MCP tools per server and tool, each memory file, agents, skills), estimated tool-result tokens by tool with the 10 largest results, and the context size at the end of each stage. A summary row adds sessions, max peak %, total compactions and `context_strategy`. `closeout.md` gets a `Context:` line. The breakdown and window come from `claude -p /context` run in the workspace before removal (no model turn, no transcript left behind); without `claude` the files say the breakdown was not read and the rest is still written.
