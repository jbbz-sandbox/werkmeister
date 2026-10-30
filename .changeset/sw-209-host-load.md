---
"werkmeister-core": patch
"werkmeister": patch
---

SW-209: `pr gate` and `pr open` wait before each lint, test and release check while the host's 1-minute load is above `budget.host_load` (default twice the CPU count, `0` off), for up to 30 minutes, then run anyway and say so; `--no-wait` skips the wait. A failed check ends with the host load, and the generated `with-temp-home` prints the host load when its command fails, so a timeout under load reads as load.
