---
"werkmeister-core": patch
---

SW-247: the PR gate's exercise and acceptance checks fail on a result cell that is not exactly `PASS`, such as `FAIL — reason` or `skipped`, in any table with a `result` column. Before, only a cell reading exactly `FAIL` was caught.
