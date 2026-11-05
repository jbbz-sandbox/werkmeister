---
"werkmeister-core": minor
"werkmeister": minor
"werkmeister-mcp": patch
---

SW-189: `harness: codex` — a Codex CLI workspace gets werkmeister's hooks in `.codex/hooks.json` (the standards gate reads `apply_patch` paths, PermissionRequest marks needs-you, the pause gate denies without `continue: false`) and the werkmeister MCP server in `.codex/config.toml` with `default_tools_approval_mode = "approve"` and `tool_timeout_sec = 1800`.
