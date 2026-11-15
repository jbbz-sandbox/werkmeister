---
"werkmeister": patch
---

SW-754: the hidden `__parse` test hook takes `--batch '<json argv sets>'` and parses every set in one process, one JSON line per set, each on a fresh commander program. `spellings.test.ts` runs its table through one batch instead of one CLI start per spelling: about 24 → 6 CPU-s for the file. `__parse <argv…>` is unchanged.
