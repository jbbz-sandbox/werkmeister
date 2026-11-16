---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-682): a queued feature that can no longer fit the budget (queued before `budget.*` was lowered, or its compose grew) is dropped from the queue during a grant, and its session is told why with the NEVER_FITS message. The waiters behind it still start.
