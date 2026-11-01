## Description

The host daemon is the werkmeister MCP server on port 3002 (`overrides.mcp_port`). The VS Code extension, the SessionEnd stop and the scheduler reach it over HTTP. On macOS, launchd keeps it up once it is installed; elsewhere `werkmeister infra connect` starts it with a PID file.

- `status` says whether it is serving, which build it loaded (`stale (loaded <x>, on disk <y>)` after a rebuild or upgrade), and whether the launchd agent is installed and current.
- `install` writes or refreshes the launchd agent: the same step `werkmeister machine setup` offers.
- `uninstall` removes the agent and stops launchd's copy; `infra connect` starts it again.
- `restart` restarts it, through launchd when launchd owns it.

Under launchd the daemon restarts itself on a new build: once its entry changes and no call or queued feature is in flight, it exits and launchd starts it on the new code. A PID-file daemon only reports `stale`; run `restart`. The CLI warns once per run when it reaches a daemon on another build.

## Examples

```sh
werkmeister daemon status
werkmeister daemon install
```
