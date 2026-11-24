---
"werkmeister": patch
---

SW-1128: `werkmeister metrics rebuild` reads every record branch's author in the one `git for-each-ref` that lists the branches, instead of one `git log` per branch. The `metrics trends` cost and token sums now come from the same code as the `metrics` report's.
