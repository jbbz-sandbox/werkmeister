---
"werkmeister-core": patch
"werkmeister-mcp": patch
---

A message relayed from another Claude Code session now shows in `claude-transcript` as a user turn, and the new `relay-check` MCP tool says whether a relay sent at a given time was picked up by the workspace's session. When it was not, it returns `not picked up: type <text> in <session>` for the check-in skill to report instead of a success (SW-348).
