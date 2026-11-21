---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix reproduce contract's caller step now treats every route that runs a gated or refused command as a caller to check: the CLI, daemon or MCP tools, the pane, headless wakes, and other harnesses (SW-960).
