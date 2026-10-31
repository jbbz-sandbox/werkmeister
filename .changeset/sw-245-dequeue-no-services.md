---
"werkmeister-core": patch
---

SW-245: `up` now removes a feature with no local services from the waiting queue when it starts it, so the scheduler no longer leaves it waiting and re-ups it on every grant.
