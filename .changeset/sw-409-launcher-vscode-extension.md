---
"werkmeister": patch
---

`claude-resume` and `pr-reconcile` open a VS Code terminal when called from the Claude Code VS Code extension, which sets `CLAUDE_CODE_ENTRYPOINT=claude-vscode` and no `TERM_PROGRAM`; before, they opened Terminal.app (SW-409).
