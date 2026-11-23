---
"werkmeister": patch
---

SW-1116: `werkmeister metrics rebuild` copies a teammate's `metrics.jsonl` line as is, so a line from another version is not appended again on every rebuild. A run's slice pushed at close-out leaves out lines older than its record branch's first commit, so an earlier run of a reused workspace name no longer lands in it.
