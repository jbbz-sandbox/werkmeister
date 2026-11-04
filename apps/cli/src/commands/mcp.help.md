## Description

Launches the stdio MCP proxy for Claude Desktop and the werkmeister plugin. It forwards every tool call to the werkmeister daemon (`werkmeister machine setup` or `werkmeister infra connect` starts it), so a rebuild or upgrade reaches running sessions without a `/mcp` reconnect. The `werkmeister` wrapper launches it.
