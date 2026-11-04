---
"werkmeister": patch
---

`pr gate` and `pr open` now check the worktree is clean together with the other quick rows (stages, acceptance, approved, repo, exercise, review) and stop there when any fails, before lint and the tests start containers or wait for host load (SW-364).
