---
"werkmeister": patch
---

In a checkout, `werkmeister mcp` now runs `apps/werkmeister-mcp/dist/main.js`. The wrapper still pointed at the pre-rename `apps/mcp`. On a fresh clone that fell through to the bundled `dist/mcp.js`, but a checkout that still held an old untracked `apps/mcp/dist` ran that stale build, which crashed on `werkmeister-core/config` and left the werkmeister plugin's MCP server unable to connect.
