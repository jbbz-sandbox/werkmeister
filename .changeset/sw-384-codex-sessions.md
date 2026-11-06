---
"werkmeister-core": minor
"werkmeister": minor
"werkmeister-vscode": minor
"werkmeister-mcp": patch
---

SW-384: Codex sessions. A `harness: codex` workspace reads its sessions from `~/.codex/sessions`: the pane and dashboard show Working / Needs you / Done and the transcript, `claude-send` runs `codex exec [resume <id>]`, `claude-resume` and the pane's Continue / New Session open `codex`, and usage reads Codex's token counts. Machine-level asks (Jira fallback, refine) and PR reconcile stay on Claude.
