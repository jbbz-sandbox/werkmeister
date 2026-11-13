---
"werkmeister": patch
---

A workspace no longer reads "Done" while its turn left a background command running or a capacity wait queued (SW-681). The badge (pane card, VS Code, MCP `status`, check-in) reads Working, and the activity reads `Running in background: pr open` or `Queued for capacity (position N)`. A background shell now ends when Claude Code reports that task's exit, not at the next turn, so a person's or a check-in courier's message no longer clears it.
