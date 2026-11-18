---
"werkmeister-core": patch
---

Rerunning `werkmeister workspace init` on an existing workspace now commits the regenerated contracts (CLAUDE.md, CONTEXT.md, `_shared/`, each stage's CONTEXT.md) on the record branch as their own commit, `chore: regenerate workspace contracts`, so they no longer ride along with the agent's next commit. Stage outputs and notes are left alone. A live session gets a nudge to re-read its contracts (SW-760).
