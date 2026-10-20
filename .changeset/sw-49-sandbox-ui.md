---
"werkmeister-mcp": patch
---

apps/mcp now builds the MCP App pages (`mcp-app.html`, `mcp-list.html`) itself, from the new `werkmeister-ui` package (`packages/sandbox-ui`), and serves them from its own `dist/`. The dashboard and apps/mcp share one copy of the UI modules, and `werkmeister-ui` adds the non-DOM display model the card, pane and VS Code will read.
