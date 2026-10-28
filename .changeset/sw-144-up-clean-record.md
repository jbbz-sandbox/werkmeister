---
"werkmeister-core": patch
---

`werkmeister up` leaves a workspace's record branch clean (SW-144). The managed `.gitignore` now ignores compose.yml, compose.gate.yml and the runtime state files (`agent-state.json`, `last-exec`, `starts.json`). `up` adds those rules to an older workspace and untracks a committed compose.yml once. init-workspace seeds `.env` before writing settings, so its allow rules already match what `up` writes.
