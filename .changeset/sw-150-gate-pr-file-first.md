---
"werkmeister-core": patch
---

`werkmeister pr gate` and `pr open` run the PR-file checks (stages, acceptance, approved) first and stop before any test command when one fails (SW-150), so a malformed PR file fails in seconds instead of after every registry test command. The acceptance failure message and `pr-rules.md` now state the accepted format: a result cell that is exactly `PASS` or `FAIL`, evidence in its own column.
