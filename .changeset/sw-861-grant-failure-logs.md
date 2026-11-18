---
"werkmeister-core": patch
---

A start that fails in compose now says `werkmeister feature logs <feature>` shows why, not "see the compose output above": when the grant starts a waiter, that output goes to another process, and the session's nudge carried the dead pointer (SW-861).
