---
"werkmeister-core": patch
"werkmeister": patch
"werkmeister-vscode": patch
---

SW-187: Claude Code-specific code now sits behind a harness interface (`harness()` returning a `HarnessAdapter`), with the Claude adapter under `harness/claude/` in core, the MCP server, the CLI and the VS Code extension. That covers the `claude` CLI calls, `CLAUDE.md` and hooks generation, the transcript reader, usage and pricing, session driving, the 4 `claude-*` MCP tools, `detect --assist`'s Agent SDK resolver, the `claude --continue` terminals, `wrap_up` and PR rule 5's Desktop sentence. No behaviour change: generated workspace files and the MCP tool list are identical, and every old export from `werkmeister-core` still resolves.
