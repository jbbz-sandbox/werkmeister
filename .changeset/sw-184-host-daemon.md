---
"werkmeister": minor
---

The HTTP MCP server on port 3002 is now the host daemon (SW-184). Each workspace gets its own token, so a dev-container agent can drive that workspace's lifecycle (and only that workspace's) through the daemon. The VS Code extension and the SessionEnd auto-stop go through the daemon too.

- **Per-workspace tokens:** `init-workspace` writes `~/.werkmeister/tokens/<workspace>`, with a copy in the git-ignored `.werkmeister/token`. On `/mcp` the token lists only that workspace's verbs and refuses any other workspace (code `SCOPE`). `close-out` deletes it.
- **New endpoints:** `POST /api/tool` (machine token) for host thin clients, and `GET /api/logs/stream` (SSE) for following logs.
- **New tools:** `clean`, `stats`, `optimize`, `cache`, `registry`, `resources` and `intercepts`.
- **VS Code:** the extension's status (5 s), resources (30 s), intercepts, close-out and log follow now go through the daemon. It shows "werkmeister daemon not running" when the daemon is down.
- **SessionEnd auto-stop:** `stop --if-idle` hands the stop to the daemon, and falls back to a local stop when the daemon is down. The hook fast paths (`hooks gate`, `pr-guard`, `agent-state`) are unchanged.
- **Test switch:** `WERKMEISTER_FIXTURE=1` keeps a run off Caddy, k8s forwards, telepresence, `/etc/hosts` and the real `gh`.
- **Fix:** the `status` tool's output schema accepts every workspace field, so an MCP client that lists tools first no longer rejects its result.
- **Port setting:** `overrides.mcp_port` / `WERKMEISTER_MCP_PORT` now sets the daemon's port.

**Breaking, on upgrade:**

1. On macOS, run `werkmeister setup` and accept "Install the launchd agent?". It installs `com.werkmeister.daemon`, which keeps the daemon up, and replaces the 3002 process `connect` started. Elsewhere, keep using `werkmeister connect`.
2. Re-run `werkmeister init-workspace` in every open workspace. It writes the workspace token and regenerates `.mcp.json`. The pre-SW-106 `x-sandbox-feature` header is no longer read.
3. Container agents set `WERKMEISTER_MCP_TOKEN` from the workspace's `.werkmeister/token`, not `~/.werkmeister/mcp-token`.
4. Reload VS Code windows so the extension picks up the change.

**Rollback:** reinstall the previous version and run `launchctl bootout gui/$(id -u)/com.werkmeister.daemon`. Older versions ignore the token files.
