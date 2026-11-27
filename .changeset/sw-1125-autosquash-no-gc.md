---
"werkmeister": patch
---

SW-1125: `werkmeister pr autosquash` runs its rebase, and `issue start` its worktree fetch, with `maintenance.auto=false` and `gc.auto=0`, so neither starts an automatic gc or maintenance in the source clone that every workspace's worktree shares.
