---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1139: in a grouped workspace, `werkmeister pr gate` (and `pr gate --tests`) has a `revert` row. It reverts each commit in `origin/<base>..HEAD` alone in a throwaway worktree off HEAD, then removes it, and fails naming each commit that conflicts (`<sha> <subject>` and the files). The ICM commit stages tell a grouped run to put each ticket's new tests in a file of its own and keep tickets off adjacent lines. Single-ticket workspaces get neither.
