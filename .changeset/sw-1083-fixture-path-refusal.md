---
"werkmeister": patch
---

`with-fixture-workspace`'s file options (`--workspace`, `--config`, `--services`, `--running`, `--fragment` and the rest) name the path they resolved and the worktree it must be under when it is outside. A host absolute path given in the container used to get only "a file under the worktree", with no hint that paths resolve against /app (SW-1083).
