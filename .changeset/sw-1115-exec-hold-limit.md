---
"werkmeister-core": patch
---

SW-1115: a capacity wait that holds off releasing its running containers because a `docker exec` runs in them now holds for 5 minutes at most, then releases them anyway and records why, as any release does. An exec that never ends (a watch-mode test run, an attached shell) no longer holds the set for the whole 30-minute gate wait, and two gates doing that no longer deadlock.
