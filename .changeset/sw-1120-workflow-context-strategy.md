---
"werkmeister-core": patch
---

`with-fixture-workspace --workflow` exits 2 when the `--workspace` file sets a `context_strategy` other than `icm`. The file used to win, so the fixture initialised as jit, never read the seeded workflow, and exited 0 (SW-1120).
