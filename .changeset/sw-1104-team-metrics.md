---
"werkmeister": minor
"werkmeister-core": minor
"werkmeister-mcp": minor
---

Team view of the metrics (SW-1104). Close-out pushes the run's own lines of the event log as `metrics.jsonl` on its record branch. `werkmeister metrics rebuild` adds every teammate's slice to your log and caches each record branch's `usage.json` with the branch's git author email (`~/.werkmeister/metrics/usage-branches.jsonl`). The `metrics` report (`metricsReport`) now covers everyone: it adds `releases` (distinct release tags in the range, per week, for deployment frequency) and `usage.byPerson` (with lead time), `usage.byProject` (ticket key prefix) and `usage.byModel`.
