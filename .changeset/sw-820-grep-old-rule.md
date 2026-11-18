---
"werkmeister-core": patch
---

The reproduce contract's permission-rule step now also asks for a `git grep -F` of the exact old rule text across the whole repo, tests and `apps/` included, with each hit listed as a site the fix must update (SW-820).
