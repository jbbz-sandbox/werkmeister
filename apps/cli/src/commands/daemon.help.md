## Description

The host daemon is the werkmeister MCP server on port 3002 (`overrides.mcp_port`). The VS Code extension, the SessionEnd stop and the scheduler reach it over HTTP. On macOS, launchd keeps it up once it is installed; elsewhere `werkmeister infra connect` starts it with a PID file.

- `status` says whether it is serving and whether the launchd agent is installed and current.
- `install` writes or refreshes the launchd agent: the same step `werkmeister machine setup` offers.
- `uninstall` removes the agent and stops launchd's copy; `infra connect` starts it again.
- `restart` restarts it, through launchd when launchd owns it.

## Examples

```sh
werkmeister daemon status
werkmeister daemon install
```
