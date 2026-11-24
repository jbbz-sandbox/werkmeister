---
"werkmeister": patch
---

`with-fixture-workspace --workflow` exits 2 on a `stages/<name>.md` that is a dangling symlink, instead of crashing with ENOENT. New tests cover a stage file and a `--then-append` target symlinked out of the worktree or fixture (SW-1119).
