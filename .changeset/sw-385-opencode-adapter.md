---
"werkmeister-core": minor
"werkmeister": minor
---

SW-385: `harness: opencode` (checked on OpenCode 2.2.5). `workspace init --harness opencode` writes AGENTS.md, `.agents/skills`, a plugin in `.opencode/plugins/werkmeister.js` that runs the standards gate, PR guard and agent state, and `opencode.json` with the werkmeister MCP server (scoped by the workspace token) and shell deny rules for shared infra, other workspaces, global installs and `gh pr merge`. Session tools (`claude-send`, transcripts, the Workspaces pane) drive OpenCode over `opencode run` and `opencode session list` / `export`. Session-start context and auto-stop do not run on OpenCode.
