---
"werkmeister": minor
---

One MCP server (SW-48). `werkmeister mcp` now serves every tool, including the dashboard's, over stdio and over HTTP on :3002, with one name per verb and no aliases. The plugin's server is `werkmeister` (tools `mcp__plugin_werkmeister_werkmeister__*`), not `workspaces`. Renamed: `workspace-status` → `status`, `workspace-action` → `up` / `stop` / `restart` / `down`, `sandbox-connect` → `connect`, `open` → `open-feature`, `remove` → `remove-service`, the `workspace` form tool → `create-workspace-form`. Workspace-scoped tools take one `workspace` argument (directory or feature name) in place of `name` / `feature`. `werkmeister dashboard` now runs the localhost browser dashboard and no longer serves MCP. Update a Claude Desktop entry to `{ "werkmeister": { "command": "werkmeister", "args": ["mcp"] } }`.
