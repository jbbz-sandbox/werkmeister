---
"werkmeister": patch
---

SW-733: `werkmeister pr gate` fails a branch that holds a merge commit from its base, naming the rebase to run instead, since a rebase merge queue replays only non-merge commits.
