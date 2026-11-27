---
"werkmeister-core": patch
---

A workflow folder symlinked into `~/.werkmeister/workflows/` from a repo now gets a repo workflow's grants, not the user grants: `grantsFor` compares real paths (SW-1122).
