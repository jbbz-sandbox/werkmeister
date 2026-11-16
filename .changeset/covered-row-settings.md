---
"werkmeister": patch
---

SW-808: `werkmeister pr gate` and `pr open` no longer treat a test row as covered when the branch changes that service's container settings. The service starts from `compose.gate.yml` and runs its own row there, so the new settings are tested, whether its cover was declared with `test_covered_by` or detected from `--filter`s.
