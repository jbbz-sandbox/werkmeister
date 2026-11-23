---
"werkmeister": patch
---

`pr gate` and `pr open` no longer run lint or test rows in containers that their own capacity wait stopped. After a start that waited and gave up, the gate reads Docker again: the stopped containers get a `containers` row naming the wait, and their rows print `not run: waiting on capacity` (exit 75) instead of failing with `container is not running` and a note blaming an outside stop (SW-1070).
