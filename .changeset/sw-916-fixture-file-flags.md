---
"werkmeister": patch
---

`with-fixture-workspace` file flags (`--services`, `--workspace`, `--config`, `--running`, `--fragment`, `--fragment-change`, `--change-base`, `--change-branch`) now resolve and are checked against the worktree of the CLI that runs, not the shell's current folder, so the pre-approved wrapper can't read a file outside the workspace from another working directory (SW-916).
