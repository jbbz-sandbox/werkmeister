---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity hook (SW-768): while a workspace waits for capacity, its session is held only for commands that need containers or the CPUs (`docker`, `pnpm`/`npm`/`node` and other test runners, `with-temp-home`, `feature up`/`restart`, `pr gate`/`pr open`). Edits, reads, git on the record, `werkmeister feature stop` and prompts go through, so a person's approval can still be written and committed while queued. A paused workspace still holds everything.
