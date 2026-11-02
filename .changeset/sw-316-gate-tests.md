---
"werkmeister-core": minor
"werkmeister": minor
---

`werkmeister pr gate --tests` runs the gate's lint and test rows in the workspace container on the uncommitted tree; the implement stage runs it so container-only failures show before `pr open` (SW-316).
