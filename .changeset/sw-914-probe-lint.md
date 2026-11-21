---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix reproduce contract now runs the repo's `Format:` command on its failing probe test, and the fix contract folds that probe into the ticket's committed test (or moves it to `stages/01_reproduce/output/`) before the lint chain, so an untracked probe no longer fails the lint chain or the gate's clean-worktree check (SW-914).
