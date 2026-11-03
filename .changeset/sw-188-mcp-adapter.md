---
"werkmeister-core": minor
"werkmeister": minor
---

SW-188: a generic MCP adapter. `werkmeister workspace new --harness mcp` (config `harness`, env `WERKMEISTER_HARNESS`) generates a workspace for any agent harness with MCP and skills: `AGENTS.md` instead of `CLAUDE.md`, skills in `.agents/skills`, no subagents, and hooks reported as unavailable (`hooks: unavailable on mcp …` at init and `up`, the `hooks` MCP tool's new `hooks` field, a note in `AGENTS.md`) rather than silently missing. The harness connects to the host daemon at `http://127.0.0.1:3002/mcp`; `docs/harnesses.md` says how for Codex CLI, Cursor and Copilot CLI.
