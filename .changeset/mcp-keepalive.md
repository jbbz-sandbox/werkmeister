---
"werkmeister": patch
---

The daemon's `/mcp` keep-alive now follows `WERKMEISTER_DAEMON_HEARTBEAT_MS` (default 60 s, as `/api/tool`) instead of the MCP SDK's own 15 s default, so an SDK update can't drop it and a tool call that is quiet for more than 5 minutes still stays under undici's body timeout (SW-722). Calls never failed this way today; no session needs to reconnect.
