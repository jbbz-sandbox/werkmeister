---
"werkmeister": patch
"werkmeister-core": patch
---

`with-temp-home` takes `--cwd <dir>` (after `--no-wait`) and runs its command there, whatever the shell's cwd; in the werkmeister container the same worktree maps to `/app`. The test commands in `werkmeister-context.md` and their allow rules now pass `--cwd <ws>/<repo>`, so they work from the workspace root too, still with no `cd` (SW-652). Rerun `werkmeister workspace init` to regenerate the file; `werkmeister machine migrate` refreshes the rules and the wrapper.
