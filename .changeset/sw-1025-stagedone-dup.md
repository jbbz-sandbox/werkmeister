---
"werkmeister": patch
"werkmeister-core": patch
---

A workspace that was open when `werkmeister metrics rebuild` ran no longer gets a second `stage.done` for a stage rebuild already logged (SW-1025). Rebuild writes no claim file, so the live sweep wrote the same stage and commit again. It now skips a filled, unclaimed stage that the log already has for this workspace's history, and claims it. Stage timings were already right; readers that count lines now see each stage once.
