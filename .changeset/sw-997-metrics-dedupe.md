---
"werkmeister": patch
"werkmeister-core": patch
---

The metrics Flow reader counts one `pr.open`, `pr.merged` and `release` line per PR (SW-997). A racing `pr watch` and `pr status` could write the same `pr.merged` line twice and inflate the PR-wait total.
