---
"werkmeister": patch
---

SW-1158: `werkmeister metrics rebuild` tags the `stage.done`, `pr.open` and `pr.merged` lines it rebuilds from a record branch with the `run_id` in that branch's `.werkmeister/workspace.yml`. A same-named run's late `pr.merged` that a rebuild logs from now on stays out of your run's slice and out of the `metrics.jsonl` your close-out pushes. A line an earlier rebuild already logged keeps no `run_id`, since rebuild never adds a line it already has. Branches from before run ids rebuild untagged, as before.
