---
"werkmeister-core": patch
"werkmeister": patch
---

`werkmeister pr gate` now prints `✓ containers: skipped (<container> already running)` when a running feature container means it skips starting a service, instead of omitting the row.
