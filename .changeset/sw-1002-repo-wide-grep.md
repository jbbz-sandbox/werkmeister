---
"werkmeister-core": patch
---

ICM `01_research` runs its value grep with one `git grep` from the repo root across every package and app, not only the package the change touches, and records the command and its scope in `inventory.md` (SW-1002).
