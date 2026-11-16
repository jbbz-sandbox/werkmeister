---
"werkmeister-core": patch
---

SW-721: the container test line in `werkmeister-context.md` and its allow rule escape a `'` in the test or lint command (`'\''`), so both run the registered command instead of a different word split.
