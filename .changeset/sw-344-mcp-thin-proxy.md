---
"werkmeister": minor
---

`werkmeister internal mcp`, the MCP server the werkmeister plugin and Claude Desktop start per session, is now a thin stdio proxy to the host daemon. Tool calls run in the daemon, which restarts itself on a new build, and the proxy sends `tools/list_changed` when it does, so a rebuild or upgrade reaches every running session without a `/mcp` reconnect (SW-344).

**This upgrade needs one `/mcp` reconnect or session restart**, as will any later change to the proxy itself (release notes will say). The daemon must be running: `werkmeister machine setup` (macOS) or `werkmeister infra connect`. When it is down, a tool call says so instead of running old code.
