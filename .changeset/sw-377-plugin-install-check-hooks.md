---
"werkmeister-core": patch
---

SW-377: the werkmeister-install-check hooks ship with the Claude Code plugin. The plugin's hooks module runs `skills/install-check/check.sh --fix` when an interactive session starts and, after a repair, refuses the person's next typed prompt once; messages from other sessions, background notifications, slash commands and headless sessions are never refused (SW-348). `werkmeister machine setup` retires the hand-copied `~/.claude/settings.json` hook entries and names the leftover `~/.claude/skills/werkmeister-install-check` folder.
