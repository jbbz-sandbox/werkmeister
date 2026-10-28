---
"werkmeister-core": patch
---

SW-115: the shipped `mcp-client` archetype no longer projects the `werkmeister` MCP server into a workspace's `.mcp.json`. That file is shared by host and container sessions, and the entry's `http://host.docker.internal:3002/mcp` only resolves in a container, so every host session hit `ENOTFOUND` on start. Host sessions get the same server from the `werkmeister` plugin. The next `init-workspace` prunes the entry from existing workspaces. A container agent opts back in with an archetype of its own (`docs/users-guide.md`, edit 3).
