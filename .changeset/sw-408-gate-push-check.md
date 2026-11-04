---
"werkmeister": patch
---

`pr gate` and `pr open` check push access first (`git push --dry-run origin <branch>`): with no access they fail within seconds with a ✗ push row naming the git error and how to fix it, and run no lint or tests (SW-408).
