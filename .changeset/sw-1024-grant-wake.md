---
"werkmeister": patch
"werkmeister-core": patch
---

A granted capacity start is no longer reaped before its session hears of it (SW-1024). The workspace's own session now takes a pending "continue" (`.werkmeister/resume-nudge.json`, from a grant or Resume) as a prompt at its next band poll, not only when the root `/workspaces` pane is open. The idle reaper keeps a feature while that "continue", left less than `idle_stop_minutes` ago, is undelivered and a session is open (`kept (continue not yet delivered)`).
