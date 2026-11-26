---
"werkmeister": patch
---

SW-1214: the install-check skill's `queue-pr.sh` now waits on a PR that something else already put in the merge queue (`already queued (position N)`) and exits 0 when it merges, instead of failing with `could not be queued`.
