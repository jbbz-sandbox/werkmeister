---
"werkmeister": patch
---

A workspace container now mounts its git worktree's admin dir (`<repo>/.git/worktrees/<name>`) read-write instead of read-only (SW-785). In a container that also mounts the main checkout (as werkmeister's own werkmeister-core does), a git command that writes the index (`git checkout -- <file>`, `git reset`) now works instead of failing with `index.lock: Read-only file system`. It takes effect once a workspace's compose.yml is regenerated.
