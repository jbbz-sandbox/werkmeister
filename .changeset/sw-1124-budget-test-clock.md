---
---

SW-1124: the budget test writes its waiter's `since` per test, so its "waited 12 min" line no longer depends on how long the file has run (it failed on a loaded host).
