---
"werkmeister": minor
---

SW-432: `werkmeister issue create --relates <key>` (repeatable) links the new issue "relates to" each key after creating it and prints each link. Every key is checked before anything is filed; a link Jira refuses still prints the new key, then exits 1. The generated `issues-report.md` shows the flag and, in a workspace with an issue, says to pass it for a follow-up.
