---
"werkmeister": patch
"werkmeister-core": patch
---

SW-1182: `werkmeister metrics rebuild` now tags in place a `stage.done`, `pr.open` or `pr.merged` line that an earlier rebuild logged without the record branch's `run_id`, so a same-named run's late `pr.merged` stops leaking into a run's slice on machines that rebuilt before SW-1158. Lines from branches with no `run_id`, and every other event, are left byte for byte.
