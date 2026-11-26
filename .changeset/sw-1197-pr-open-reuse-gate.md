---
"werkmeister": patch
"werkmeister-core": patch
---

`werkmeister pr open` reuses a passing tested gate on the same HEAD, `origin/<base>` and lint and test commands, with a clean tree, so it runs only the PR-file, base, clean, revert and release rows. A failed `gh pr create` keeps the record, so a retry no longer reruns the tests. A passing `pr gate --tests`, `pr gate` or `pr open` writes the record (`.werkmeister/logs/gate-pass-<worktree>.json`), and a failing one deletes it. The fixture gains `--create-fails`, which makes the fake `gh pr create` fail (SW-1197).
