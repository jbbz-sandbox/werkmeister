---
"werkmeister-core": minor
"werkmeister": minor
---

SW-105: the `/workspaces` pane's cards group their buttons by what they act on, one labelled row each: `session` (⇆ Open beside, which replaces ↗ Continue in Desktop and falls back to opening the session in place when the app won't split it; Continue in Terminal / VS Code; ＋ New session; 📌 Pin), `containers` (Up / Resume, Stop, Pause, Restart, Down, then Logs and Open feature ↗ while they run) and `work` (Refresh PRs, Open issue ↗, Close out, Abandon…). The `⋯` menu is gone. Logs opens a Terminal window following the containers' logs (new `followLogsInTerminal` in werkmeister-core). The dashboard, MCP App and VS Code are unchanged.
