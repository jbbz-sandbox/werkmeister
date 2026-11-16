---
"werkmeister": minor
---

SW-574: `werkmeister pr gate` and `pr open` no longer start a service's container for a test row another row in the same gate already runs. A service is covered when its registry entry sets `test_covered_by: <service>`, or when its command matches the other row's except for a strict subset of its `--filter`s. The covered row reads `covered by <service>` and passes or fails with that row.
