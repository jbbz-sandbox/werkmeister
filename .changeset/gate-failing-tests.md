---
"werkmeister": patch
---

`pr gate` / `pr open`: a failed lint, test or release row now names the failing tests (`not ok`, `✖`, `×`, `FAIL` lines from anywhere in its output) above its tail, and saves the whole output to `.werkmeister/gate-<repo dir>-<row>.log` in the workspace root, printing that path (SW-317).
