---
"werkmeister-core": patch
"werkmeister": patch
---

Before a run fixes a problem outside its own tickets (a flaky test it trips over, say), the issues guide (ICM and JIT) and the bugfix fix contract now ask it to search the tracker for an open ticket, file one if there is none, and cite its key in the commit and the PR, so a parallel run sees the fix is in flight (SW-898).
