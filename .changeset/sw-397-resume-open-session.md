---
"werkmeister": patch
---

Resume no longer runs a headless `claude -p --resume` beside an open interactive session: a headless turn's `SessionEnd` can't erase the open session's live record, and Resume checks for an interactive `claude` running in the workspace before it goes headless, leaving the "continue" nudge for it instead (SW-397).
