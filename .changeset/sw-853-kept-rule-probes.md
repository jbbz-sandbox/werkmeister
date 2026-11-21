---
"werkmeister-core": patch
"werkmeister": patch
---

The bugfix 01_reproduce contract now asks for the same trailing-argument probes (another feature or workspace name, `-w`/`--workspace <path>`, extra positional args) on every rule a permission fix keeps on the same command, not only on the rule it changes, and the failing test covers them (SW-853).
