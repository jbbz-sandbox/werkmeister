---
"werkmeister": patch
---

A queued workspace whose containers already run is no longer held (SW-986). Before the hook denies a command as "waiting for capacity", it asks Docker whether the feature runs; if it does, the queue entry is stale and is cleared.
