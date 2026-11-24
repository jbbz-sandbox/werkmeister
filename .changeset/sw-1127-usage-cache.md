---
"werkmeister": patch
---

SW-1127: when `werkmeister metrics rebuild` can't read the record branches' `usage.json`, it keeps the old `usage-branches.jsonl` and warns, instead of writing it empty and losing the per-person and per-project usage from the `metrics` report until the next good rebuild.
