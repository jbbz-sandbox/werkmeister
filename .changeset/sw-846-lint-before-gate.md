---
"werkmeister": patch
---

The ICM fix and implement stages now run the repo's format command where the service's tests run (its container when its validate text says so), and its registered lint command there before `werkmeister pr gate --tests`, so a one-file fast route no longer leaves a format error for the gate's lint row (SW-846).
