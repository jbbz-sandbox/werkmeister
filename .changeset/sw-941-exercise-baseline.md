---
"werkmeister": patch
"werkmeister-core": patch
---

`pr gate` / `pr open` skip a `Baseline…` section of `exercise.md` (from its heading down to the next heading of its level or higher), so the FAIL rows that record a bug before its fix no longer fail the exercise check (SW-941). A FAIL anywhere else still fails it. The ICM contracts and the `w9r-test` skill name the heading.
