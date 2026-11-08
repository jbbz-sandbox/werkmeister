---
"werkmeister": patch
---

A crashed session's record now expires (SW-559). After 24 hours with no hook event, a busy record with no pending ask is dropped and its file deleted, so status sweeps stop running the `ps` + `lsof` probe for it and the card stops showing "The session stopped with work unfinished". Idle records and pending questions or permission prompts are kept. Check-in's first run no longer picks a workspace only because a crash loop or notice made it read Needs you. It now picks workspaces with a question, permission, plan or gate waiting, or where Claude spoke last.
