---
"werkmeister-core": patch
---

SW-508: standards links ignore `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` inherited from a calling git (a `rebase --exec` step, a hook), so they name the standards tree's own repo, not the caller's.
