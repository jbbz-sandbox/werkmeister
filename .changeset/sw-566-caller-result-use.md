---
"werkmeister": patch
---

SW-566: the bug-fix and incident `01_reproduce` step 4 now also lists what each caller does with the result (an early return, a printed value, a stored state), so the fix's return shape is checked against every caller before the fix stage. New workspaces get the text.
