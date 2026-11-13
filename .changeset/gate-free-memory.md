---
"werkmeister": patch
---

`pr gate` and `pr open` check free memory before they start a container (SW-620). Under `budget.free_memory` percent available (default 15; `0` turns it off) they read `retry later (low memory)` and exit 75 without starting anything, since Claude Code stops an idle background gate when the Mac runs low. `.werkmeister/bin/with-temp-home`'s 90 s wait, and a setup start's, now wait on free memory as well as host load, on macOS too, where memory is read from `kern.memorystatus_level`. A gate whose setup start fails with `HOST_LOAD` is now a retry (exit 75), not a failure.
