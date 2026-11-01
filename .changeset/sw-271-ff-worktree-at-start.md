---
"werkmeister-core": minor
"werkmeister": minor
---

SW-271: `werkmeister issue start`, step 0 of the first ICM stage and of JIT's `w9r-research`, now also brings each code worktree up to its base. It fetches origin, and a branch with no commits of its own is fast-forwarded to `origin/<base>`. A branch with its own commits, uncommitted changes, or a fetch that fails is left as is, with a `Worktree:` line such as `app: 4 commits behind origin/main (has its own commits, left as is)`. It still exits 0, so a stage never fails on it. A wave workspace created days before its run no longer starts research on stale code.
