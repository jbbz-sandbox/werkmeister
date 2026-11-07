---
"werkmeister-core": patch
"werkmeister": patch
---

SW-520: every git call werkmeister makes drops `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` inherited from a calling git (a `rebase --exec` step, a hook), so `git -C <dir>` acts on `<dir>` and not on the caller's repo. This covers `run`/`runAsync`, `runCapture` and every child started with `childEnv()` (handoff commit and push included), the `with-fixture-workspace` fixture, and the stale-build check. The test runners clear the same variables, so a suite started from `rebase --exec` can no longer re-init the real repo.
