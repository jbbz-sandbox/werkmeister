---
"werkmeister": patch
---

`werkmeister workspace close` names the `release: none` fix only for a merged PR that set `skip_release`, so a PR waiting for its release tag is no longer told to skip it. `werkmeister pr status` says `merge commit unknown` when a merged PR file has no `merge_sha`, instead of a garbled line (SW-393).
