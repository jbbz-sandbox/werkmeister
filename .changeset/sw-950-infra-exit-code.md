---
"werkmeister": patch
---

`werkmeister infra stop`, `infra restart` and `infra down` exit 1 when Docker or compose fails, instead of 0 after logging the error, so a script or agent checking the exit code no longer takes a failed stop for a success (SW-950).
