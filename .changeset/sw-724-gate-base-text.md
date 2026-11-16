---
"werkmeister": patch
"werkmeister-core": patch
---

`pr gate` (SW-724): the fragment and lockfile base lookups, and `--tests`' diff, share one `git merge-base` per gate run instead of running it once each.
