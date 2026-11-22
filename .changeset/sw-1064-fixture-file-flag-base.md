---
"werkmeister": patch
---

`with-fixture-workspace` (the CLI's internal fixture command) now reads its file flags (`--workspace`, `--config`, `--services`, `--running` and the rest) only when the running build is a worktree's `apps/cli/dist/main.js`. Under any other layout, such as an npm global install, where `../../..` of the entry was `<prefix>/lib`, it refuses every file flag (SW-1064).
