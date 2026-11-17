---
"werkmeister-core": patch
---

The waiting queue no longer drops a queued feature without telling its session. When the grant's start fails after admission (a failed `compose up`, for example), the session's waiting state is cleared and it is told to rerun `werkmeister feature up`. A waiter whose slot lease is gone is started from its workspace instead of being dequeued (SW-848).
