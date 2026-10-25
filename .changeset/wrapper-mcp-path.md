---
"werkmeister": patch
---

In a checkout, `werkmeister mcp` now runs `apps/werkmeister-mcp/dist/main.js`. The wrapper still pointed at the MCP app's pre-rename folder. On a fresh clone that fell through to the bundled `dist/mcp.js`, but a checkout that still held an old untracked build under the pre-rename name ran that stale build, which crashed on `werkmeister-core/config` and left the werkmeister plugin's MCP server unable to connect.
