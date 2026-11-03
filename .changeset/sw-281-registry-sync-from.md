---
"werkmeister": minor
"werkmeister-core": minor
---

`werkmeister registry sync --from <worktree> --out <file>` merges that checkout's `.werkmeister/services.yaml` in place of its repo's fragment and writes the registry to `<file>`, so a fragment change can be proven inside the workspace before merge. `~/.werkmeister` is left untouched; `--check` works against `--out` too (SW-281).
