---
"werkmeister": patch
"werkmeister-mcp": patch
---

SW-631: the daemon refuses a request with no token on every bind, loopback included. Before, a daemon bound to 127.0.0.1 gave machine scope to any request without an `Authorization` header. On OrbStack a container's request to `host.docker.internal` reaches a loopback bind from 127.0.0.1, so any feature container could run any tool on every workspace. The launchd daemon binds 0.0.0.0 and already required the token. The CLI, the plugin's `werkmeister internal mcp`, devcontainers, OpenCode and Codex already send one; a harness registered by hand without a token (Cursor, Copilot, a global `codex mcp add`) must now send the workspace's `.werkmeister/token`.
