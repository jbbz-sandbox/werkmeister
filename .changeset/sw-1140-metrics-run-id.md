---
"werkmeister": patch
---

SW-1140: `workspace init` gives each workspace run an id, `run_id` in `.werkmeister/workspace.yml`, made once and kept by every rerun. Every metrics event the workspace logs carries it, and a run's slice (stage times, the `metrics.jsonl` close-out pushes) keeps only lines with its own id. A teammate's run of the same name, or a late `pr.merged` or `release` from an earlier run of a reused name, no longer lands in it. Lines written before this still slice by name and the record branch's first commit.
