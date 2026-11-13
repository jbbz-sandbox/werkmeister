---
"werkmeister": minor
---

The workspaces dashboard now ships in the npm package. `werkmeister infra connect` starts it on port 3001 and `werkmeister internal dashboard` runs it in the foreground on an `npm i -g` install, where both previously needed a checkout. The browser form (`werkmeister workspace new --browser-form`) and the Claude Desktop MCP App pages ship too, so a package install no longer falls back to text for them.
