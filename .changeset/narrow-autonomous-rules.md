---
"sandbox-core": minor
---

Narrow the `autonomous` permission rules to the workspace's own feature. `Bash(sandbox|docker|npm|gh:*)` and the whole sandbox-workspace MCP server give way to per-command rules (`sandbox up|restart|logs|test <feature>`, `docker exec|logs|restart <feature>-<svc>`, `npm ci|run|test`, read-only `gh` and MCP tools), and a recorded `permissions.deny` blocks `sandbox proxy-reload|down|remove-workspace`, `docker stop|rm`, `npm publish|link` and global installs, `gh pr merge`, and the cross-workspace MCP tools. Rerunning `init-workspace` or `sandbox up` replaces the old rules.
