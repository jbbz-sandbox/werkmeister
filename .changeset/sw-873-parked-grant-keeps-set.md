---
"werkmeister-core": patch
---

The grant pass no longer stops a parked `--service` waiter's own running containers: with no wait it could not park again, so the workspace was left with nothing running and no queue place. Any other way a parked waiter leaves the queue now tells its session why (SW-873).
