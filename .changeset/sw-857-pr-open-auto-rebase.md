---
"werkmeister-core": minor
"werkmeister": patch
---

`pr open` rebases a branch not yet pushed onto `origin/<base>` when it is behind and the rebase applies with no conflict, then tests the result; the base row says how many commits it rebased onto. A conflict aborts the rebase, leaves the branch as it was, and fails the base row naming the files. `pr gate` still only reports a branch behind its base (SW-857).
