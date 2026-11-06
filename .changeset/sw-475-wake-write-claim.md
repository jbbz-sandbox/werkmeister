---
"werkmeister-core": patch
---

SW-475: `pr watch` claims a held wake by rename before appending to it, the way the hook claims it before delivering, so a hook that delivers while `pr watch` writes no longer hands the session the same wake twice.
