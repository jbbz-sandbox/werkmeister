---
"werkmeister": patch
---

`pr open` under `WERKMEISTER_FIXTURE=1` pushes only to a local origin and otherwise prints `push skipped (fixture)`, so an end-to-end fixture run can open a PR with no write to GitHub (SW-381).
