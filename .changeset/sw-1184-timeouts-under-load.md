---
"werkmeister-core": patch
---

A `pr gate` test row whose only failures are timeouts (vitest's worker RPC timeout, or a test that timed out), and that ends with host load over `budget.host_load` (the Docker VM's on macOS), no longer fails the gate as red. It ends with `failed under host load N (over L): rerun` and the gate exits 75, as for no capacity. An assertion failure, a type error, or the same timeouts at normal load still fail (SW-1184).
